// Auth middleware. По AUTH_MODE:
//   dev  — принимает X-Dev-Auth: <DEV_AUTH_SECRET> (аттестацию нельзя воспроизвести
//          на симуляторе/эмуляторе, поэтому в dev — общий секрет).
//   prod — App Attest (iOS) / Play Integrity (Android). Каркас: разбор заголовков +
//          делегирование в appAttest.js / playIntegrity.js (реальная крипто-верификация
//          требует боевых устройств + Apple/Google SDK — включается перед релизом).
// См. ARCHITECTURE.md. Attestation отвечает «подлинная ли сборка?», НЕ «оплачено ли»
// (подписка — фаза RevenueCat).
import { config } from '../config.js';
import { verifyAppAttest } from '../services/appAttest.js';
import { verifyPlayIntegrity } from '../services/playIntegrity.js';

// Идентификатор устройства для rate-limit. В dev — X-Device-Id или IP.
// В prod — из верифицированного attestation (keyId / устойчивый идентификатор).
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
      if (provided !== config.auth.devSecret) {
        return unauthorized(res, 'Неверный или отсутствующий X-Dev-Auth');
      }
      req.deviceId = deviceIdFrom(req);
      return next();
    }

    // prod: платформа по заголовку X-Platform (ios|android).
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
