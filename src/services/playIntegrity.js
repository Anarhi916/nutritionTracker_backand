// Play Integrity (Android) verification — REAL. Per protected request:
//   1) The client requests a fresh Integrity Token bound by requestHash = SHA256(nonce),
//      passing the raw nonce in X-Integrity-Nonce and the token in X-Integrity-Token.
//   2) We call the Play Integrity API decodeIntegrityToken (server-managed keys) via a
//      service account, then validate the verdict:
//        - requestDetails.requestPackageName == GOOGLE_PACKAGE_NAME
//        - requestDetails.requestHash == SHA256(X-Integrity-Nonce)     (binds token↔request)
//        - requestDetails.timestampMillis is fresh                     (anti-stale)
//        - appIntegrity.appRecognitionVerdict == PLAY_RECOGNIZED
//        - appIntegrity.packageName == GOOGLE_PACKAGE_NAME
//        - deviceIntegrity.deviceRecognitionVerdict ∋ MEETS_DEVICE_INTEGRITY
//        - (optional) accountDetails.appLicensingVerdict == LICENSED
//        - the token is single-use (sha256 stored; replay rejected)
//
// Play Integrity carries NO stable device id (by design) → rate-limit keys on X-Device-Id / IP.
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { query } from '../db/pool.js';

let authClientPromise = null;
// Lazily build the authorized Google client so the server can boot without credentials
// (dev mode / iOS-only). Reused across requests.
function getAuthClient() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({
      keyFilename: config.auth.googleCredentialsPath || undefined,
      scopes: ['https://www.googleapis.com/auth/playintegrity'],
    });
    authClientPromise = auth.getClient();
  }
  return authClientPromise;
}

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// Mark a token single-use. Returns false if it was already seen (replay).
async function claimToken(token) {
  const tokenHash = sha256hex(token);
  const expiresAt = new Date(Date.now() + config.auth.attestFreshnessSec * 1000 + 60_000);
  const { rowCount } = await query(
    `INSERT INTO attest_used_tokens (token_hash, expires_at) VALUES ($1, $2)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, expiresAt],
  );
  return rowCount > 0;
}

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyPlayIntegrity(req) {
  if (!config.auth.googleProjectNumber) {
    return { ok: false, reason: 'Play Integrity не сконфигурирован (GOOGLE_CLOUD_PROJECT_NUMBER пуст)' };
  }
  const token = req.get('X-Integrity-Token');
  const nonce = req.get('X-Integrity-Nonce');
  if (!token) return { ok: false, reason: 'нет X-Integrity-Token' };
  if (!nonce) return { ok: false, reason: 'нет X-Integrity-Nonce' };

  const packageName = config.auth.googlePackageName;

  // Decode the token via the Play Integrity API (server-managed keys).
  let payload;
  try {
    const client = await getAuthClient();
    const url =
      `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`;
    const resp = await client.request({
      url,
      method: 'POST',
      data: { integrity_token: token },
    });
    payload = resp.data?.tokenPayloadExternal;
  } catch (e) {
    console.error('[playIntegrity] decode error:', e?.message || e);
    return { ok: false, reason: 'не удалось расшифровать integrity-токен' };
  }
  if (!payload) return { ok: false, reason: 'пустой verdict' };

  const rd = payload.requestDetails || {};
  const app = payload.appIntegrity || {};
  const dev = payload.deviceIntegrity || {};
  const acc = payload.accountDetails || {};

  // Request binding + package.
  if (rd.requestPackageName !== packageName) {
    return { ok: false, reason: 'requestPackageName не совпал' };
  }
  if (rd.requestHash !== sha256hex(nonce)) {
    return { ok: false, reason: 'requestHash не совпал (token↔request binding)' };
  }

  // Freshness.
  const tsMs = Number(rd.timestampMillis);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > config.auth.attestFreshnessSec * 1000) {
    return { ok: false, reason: 'verdict устарел (timestamp)' };
  }

  // App verdicts.
  if (app.appRecognitionVerdict !== 'PLAY_RECOGNIZED') {
    return { ok: false, reason: `appRecognitionVerdict=${app.appRecognitionVerdict || '∅'}` };
  }
  if (app.packageName && app.packageName !== packageName) {
    return { ok: false, reason: 'appIntegrity.packageName не совпал' };
  }

  // Device verdict.
  const deviceVerdicts = Array.isArray(dev.deviceRecognitionVerdict) ? dev.deviceRecognitionVerdict : [];
  if (!deviceVerdicts.includes('MEETS_DEVICE_INTEGRITY')) {
    return { ok: false, reason: `deviceRecognitionVerdict=[${deviceVerdicts.join(',') || '∅'}]` };
  }

  // Optional licensing (blocks sideloaded / non-Play installs).
  if (config.auth.playIntegrityRequireLicensed && acc.appLicensingVerdict !== 'LICENSED') {
    return { ok: false, reason: `appLicensingVerdict=${acc.appLicensingVerdict || '∅'}` };
  }

  // Single-use: reject a replayed token.
  if (!(await claimToken(token))) {
    return { ok: false, reason: 'integrity-токен уже использован (replay)' };
  }

  // No stable device id in the verdict → fall back to X-Device-Id for rate-limiting.
  return { ok: true, deviceId: req.get('X-Device-Id') || undefined };
}

// Periodic cleanup of expired single-use token records.
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const timer = setInterval(() => {
  query(`DELETE FROM attest_used_tokens WHERE expires_at < now()`).catch((e) =>
    console.error('[playIntegrity] cleanup:', e.message),
  );
}, CLEANUP_INTERVAL_MS);
timer.unref?.();
