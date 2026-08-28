// Auth middleware. Per AUTH_MODE:
//   dev  — accepts X-Dev-Auth: <DEV_AUTH_SECRET> (attestation cannot be reproduced
//          on a simulator/emulator, so dev uses a shared secret).
//   prod — App Attest (iOS) / Play Integrity (Android). Skeleton: header parsing +
//          delegation to appAttest.js / playIntegrity.js (real crypto verification
//          requires physical devices + Apple/Google SDKs — enabled before release).
// See ARCHITECTURE.md. Attestation answers "is this a genuine build?", NOT "is it paid"
// (subscription — RevenueCat phase).
import { config } from '../config.js';
import { verifyAppAttest } from '../services/appAttest.js';
import { verifyPlayIntegrity } from '../services/playIntegrity.js';
import { timingSafeEqual } from 'node:crypto';

// Constant-time string compare — avoids leaking the secret via response timing.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Device identifier for rate-limit. In dev — X-Device-Id or IP.
// In prod — from verified attestation (keyId / stable identifier).
export function deviceIdFrom(req) {
  return (
    req.get('X-Device-Id') ||
    req.attestedDeviceId ||
    req.ip ||
    'unknown'
  );
}

function unauthorized(res, message) {
  return res.status(401).json({ error: 'unauthorized', message });
}

export async function authMiddleware(req, res, next) {
  try {
    if (config.auth.mode === 'dev') {
      const provided = req.get('X-Dev-Auth');
      if (!config.auth.devSecret) {
        return res.status(500).json({ error: 'server_misconfig', message: 'DEV_AUTH_SECRET не задан' });
      }
      if (!safeEqual(provided ?? '', config.auth.devSecret)) {
        return unauthorized(res, 'Неверный или отсутствующий X-Dev-Auth');
      }
      req.deviceId = deviceIdFrom(req);
      return next();
    }

    // prod: platform from X-Platform header (ios|android).
    const platform = (req.get('X-Platform') || '').toLowerCase();
    if (platform === 'ios') {
      const result = await verifyAppAttest(req);
      if (!result.ok) return unauthorized(res, result.reason || 'App Attest не прошёл');
      req.attestedDeviceId = result.deviceId;
      req.deviceId = result.deviceId;
      return next();
    }
    if (platform === 'android') {
      const result = await verifyPlayIntegrity(req);
      if (!result.ok) return unauthorized(res, result.reason || 'Play Integrity не прошёл');
      req.attestedDeviceId = result.deviceId;
      req.deviceId = result.deviceId;
      return next();
    }
    return unauthorized(res, 'Неизвестная платформа (нужен X-Platform: ios|android)');
  } catch (err) {
    return next(err);
  }
}
