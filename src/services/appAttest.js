// App Attest (iOS) verification — REAL crypto. Two phases:
//
//   1) Enrollment (once per install), POST /v1/attest/apple/register:
//      client sends the attestation object (CBOR) + keyId + the one-time challenge.
//      We verify: cert chain leaf→intermediate→Apple App Attest Root CA (pinned),
//      the nonce embedded in Apple's cert extension = SHA256(authData || SHA256(challenge)),
//      the App ID hash (APPLE_TEAM_ID.APPLE_BUNDLE_ID), the AAGUID (prod vs dev),
//      signCount==0, and that keyId == credentialId. We store the leaf public key + counter.
//
//   2) Per request (authMiddleware, prod iOS): client sends an assertion (CBOR) over
//      clientData = "<random>:<epochMillis>". We verify the ECDSA signature with the stored
//      public key, the App ID hash, freshness (timestamp), and that the hardware signCount
//      STRICTLY increases (anti-replay). No per-request server round-trip needed.
//
// Headers: X-Attest-KeyId, X-Attest-Assertion (per request), X-Attest-Nonce (per request).
// Enrollment payload (register route): { keyId, attestation (base64), challenge }.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { X509Certificate, createHash, createVerify } from 'node:crypto';
import { decode as cborDecode } from 'cbor-x';
import 'reflect-metadata'; // @peculiar/x509 (tsyringe) needs the Reflect metadata polyfill.
import * as x509 from '@peculiar/x509';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { consumeChallenge } from './attestChallenge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLE_ROOT_PEM = readFileSync(join(__dirname, 'apple-app-attest-root-ca.pem'), 'utf8');
const APPLE_ROOT = new X509Certificate(APPLE_ROOT_PEM);

// Apple's OID carrying the attestation nonce in the leaf credential certificate.
const NONCE_OID = '1.2.840.113635.100.8.2';
// AAGUID (16 bytes) identifies the App Attest environment.
const AAGUID_PROD = Buffer.from('appattest\0\0\0\0\0\0\0', 'binary'); // 9 chars + 7 NUL = 16
const AAGUID_DEV = Buffer.from('appattestdevelop', 'binary');        // 16 chars

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function appIdHash() {
  return sha256(Buffer.from(`${config.auth.appleTeamId}.${config.auth.appleBundleId}`, 'utf8'));
}

// Parse WebAuthn-style authenticator data. On attestation the attestedCredentialData
// (aaguid + credentialId) is present; on assertion only the 37-byte header is meaningful.
function parseAuthData(authDataRaw) {
  const b = Buffer.from(authDataRaw);
  if (b.length < 37) throw new Error('authData слишком короткий');
  const rpIdHash = b.subarray(0, 32);
  const flags = b[32];
  const signCount = b.readUInt32BE(33);
  let aaguid = null;
  let credId = null;
  if (b.length >= 55) {
    aaguid = b.subarray(37, 53);
    const credIdLen = b.readUInt16BE(53);
    if (b.length >= 55 + credIdLen) credId = b.subarray(55, 55 + credIdLen);
  }
  return { raw: b, rpIdHash, flags, signCount, aaguid, credId };
}

/**
 * Enrollment: verify an App Attest attestation and store the device public key.
 * @param {{keyId:string, attestation:string, challenge:string}} input
 * @returns {Promise<{ok:boolean, reason?:string, environment?:string}>}
 */
export async function registerAppAttestKey({ keyId, attestation, challenge }) {
  if (!config.auth.appleTeamId) {
    return { ok: false, reason: 'App Attest не сконфигурирован (APPLE_TEAM_ID пуст)' };
  }
  if (typeof keyId !== 'string' || !keyId) return { ok: false, reason: 'нет keyId' };
  if (typeof attestation !== 'string' || !attestation) return { ok: false, reason: 'нет attestation' };

  // 1) One-time challenge: consume atomically (single-use, unexpired).
  if (!(await consumeChallenge(challenge))) {
    return { ok: false, reason: 'challenge недействителен, истёк или уже использован' };
  }

  let obj;
  try {
    obj = cborDecode(Buffer.from(attestation, 'base64'));
  } catch {
    return { ok: false, reason: 'attestation: не удалось декодировать CBOR' };
  }
  if (!obj || obj.fmt !== 'apple-appattest' || !obj.attStmt || !obj.authData) {
    return { ok: false, reason: 'attestation: неверный формат' };
  }
  const x5c = obj.attStmt.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) {
    return { ok: false, reason: 'attestation: нет цепочки сертификатов' };
  }

  // 2) Verify the certificate chain leaf → intermediate → pinned Apple root.
  let leaf;
  let intermediate;
  try {
    leaf = new X509Certificate(Buffer.from(x5c[0]));
    intermediate = new X509Certificate(Buffer.from(x5c[1]));
  } catch {
    return { ok: false, reason: 'attestation: сертификаты не парсятся' };
  }
  const now = Date.now();
  for (const c of [leaf, intermediate]) {
    if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) {
      return { ok: false, reason: 'attestation: сертификат вне срока действия' };
    }
  }
  if (!leaf.verify(intermediate.publicKey)) {
    return { ok: false, reason: 'attestation: leaf не подписан intermediate' };
  }
  if (!intermediate.verify(APPLE_ROOT.publicKey)) {
    return { ok: false, reason: 'attestation: intermediate не подписан Apple Root CA' };
  }

  // 3) authData + nonce.
  let ad;
  try {
    ad = parseAuthData(obj.authData);
  } catch (e) {
    return { ok: false, reason: `attestation: ${e.message}` };
  }
  const clientDataHash = sha256(Buffer.from(challenge, 'utf8'));
  const expectedNonce = sha256(Buffer.concat([ad.raw, clientDataHash]));

  // 4) The nonce must equal the value in Apple's cert extension (last 32 bytes of the value).
  let extNonce;
  try {
    const pcert = new x509.X509Certificate(Buffer.from(x5c[0]));
    const ext = pcert.extensions.find((e) => e.type === NONCE_OID);
    if (!ext) return { ok: false, reason: 'attestation: нет nonce-расширения в сертификате' };
    const extBuf = Buffer.from(ext.value);
    extNonce = extBuf.subarray(extBuf.length - 32);
  } catch {
    return { ok: false, reason: 'attestation: не удалось прочитать nonce-расширение' };
  }
  if (!expectedNonce.equals(extNonce)) {
    return { ok: false, reason: 'attestation: nonce не совпал' };
  }

  // 5) App ID hash.
  if (!ad.rpIdHash.equals(appIdHash())) {
    return { ok: false, reason: 'attestation: rpIdHash не совпал (Team/Bundle ID?)' };
  }

  // 6) Counter must be 0 on the initial attestation.
  if (ad.signCount !== 0) {
    return { ok: false, reason: 'attestation: signCount != 0' };
  }

  // 7) AAGUID → environment. Reject the dev AAGUID unless explicitly allowed.
  let environment;
  if (ad.aaguid && ad.aaguid.equals(AAGUID_PROD)) environment = 'production';
  else if (ad.aaguid && ad.aaguid.equals(AAGUID_DEV)) environment = 'development';
  else return { ok: false, reason: 'attestation: неизвестный AAGUID' };
  if (environment === 'development' && !config.auth.appleAllowDevAttest) {
    return { ok: false, reason: 'attestation: development-attestation запрещён в этой среде' };
  }

  // 8) keyId must equal the credentialId embedded in the (nonce-authenticated) authData.
  let keyIdBuf;
  try {
    keyIdBuf = Buffer.from(keyId, 'base64');
  } catch {
    return { ok: false, reason: 'attestation: keyId не base64' };
  }
  if (!ad.credId || !ad.credId.equals(keyIdBuf)) {
    return { ok: false, reason: 'attestation: keyId != credentialId' };
  }

  // 9) Persist the leaf public key. Keep the higher counter if this keyId already exists
  //    (never let a re-enrollment reset the anti-replay counter downward).
  const publicKeyPem = leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  await query(
    `INSERT INTO attest_keys (key_id, public_key, sign_count, environment)
       VALUES ($1, $2, 0, $3)
     ON CONFLICT (key_id) DO UPDATE
       SET public_key = EXCLUDED.public_key,
           environment = EXCLUDED.environment,
           last_seen_at = now()`,
    [keyId, publicKeyPem, environment],
  );
  return { ok: true, environment };
}

/**
 * Per-request assertion verification (authMiddleware prod iOS path).
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyAppAttest(req) {
  if (!config.auth.appleTeamId) {
    return { ok: false, reason: 'App Attest не сконфигурирован (APPLE_TEAM_ID пуст)' };
  }
  const keyId = req.get('X-Attest-KeyId');
  const assertionB64 = req.get('X-Attest-Assertion');
  const clientData = req.get('X-Attest-Nonce');
  if (!keyId || !assertionB64 || !clientData) {
    return { ok: false, reason: 'нет X-Attest-KeyId / X-Attest-Assertion / X-Attest-Nonce' };
  }

  // Freshness: clientData = "<random>:<epochMillis>".
  const tsMs = parseInt(clientData.slice(clientData.lastIndexOf(':') + 1), 10);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > config.auth.attestFreshnessSec * 1000) {
    return { ok: false, reason: 'assertion устарел (freshness)' };
  }

  const { rows } = await query(
    `SELECT public_key, sign_count FROM attest_keys WHERE key_id = $1`,
    [keyId],
  );
  if (!rows.length) return { ok: false, reason: 'ключ не зарегистрирован (нужен enrollment)' };
  const publicKeyPem = rows[0].public_key;
  const storedCount = Number(rows[0].sign_count);

  let assertion;
  try {
    assertion = cborDecode(Buffer.from(assertionB64, 'base64'));
  } catch {
    return { ok: false, reason: 'assertion: не удалось декодировать CBOR' };
  }
  if (!assertion || !assertion.signature || !assertion.authenticatorData) {
    return { ok: false, reason: 'assertion: неверный формат' };
  }
  const signature = Buffer.from(assertion.signature);
  const authData = Buffer.from(assertion.authenticatorData);
  const clientDataHash = sha256(Buffer.from(clientData, 'utf8'));

  // ECDSA-with-SHA256 over (authData || clientDataHash) == signature over the App Attest nonce.
  let sigOk = false;
  try {
    sigOk = createVerify('SHA256')
      .update(Buffer.concat([authData, clientDataHash]))
      .verify(publicKeyPem, signature);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'assertion: неверная подпись' };

  // App ID hash.
  if (!authData.subarray(0, 32).equals(appIdHash())) {
    return { ok: false, reason: 'assertion: rpIdHash не совпал' };
  }

  // Counter must strictly increase. The conditional UPDATE also closes the race where two
  // concurrent requests carry the same counter — only one can win, the other is a replay.
  const newCount = authData.readUInt32BE(33);
  if (newCount <= storedCount) {
    return { ok: false, reason: 'assertion: counter не возрос (replay)' };
  }
  const upd = await query(
    `UPDATE attest_keys SET sign_count = $1, last_seen_at = now()
       WHERE key_id = $2 AND sign_count < $1`,
    [newCount, keyId],
  );
  if (upd.rowCount === 0) {
    return { ok: false, reason: 'assertion: counter race/replay' };
  }

  return { ok: true, deviceId: keyId };
}
