// Rate-limit per-device. На старте — in-memory (единственное не-stateless место;
// при горизонтальном масштабировании заменить на Redis — см. ARCHITECTURE.md).
// Скользящее окно: не более RATE_LIMIT_MAX запросов за RATE_LIMIT_WINDOW_MS на device.
import { config } from '../config.js';
import { deviceIdFrom } from './auth.js';

// deviceId → массив timestamp'ов запросов в текущем окне.
const hits = new Map();

// Периодическая чистка старых записей, чтобы Map не рос бесконечно.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - config.rateLimit.windowMs;
  for (const [id, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(id);
    else hits.set(id, fresh);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.(); // не держать процесс живым из-за таймера

export function rateLimitMiddleware(req, res, next) {
  const id = req.deviceId || deviceIdFrom(req);
  const now = Date.now();
  const cutoff = now - config.rateLimit.windowMs;

  const times = (hits.get(id) || []).filter((t) => t > cutoff);
  if (times.length >= config.rateLimit.max) {
    const retryAfterMs = times[0] + config.rateLimit.windowMs - now;
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).json({ error: 'rate_limited', message: 'Слишком много запросов' });
  }
  times.push(now);
  hits.set(id, times);
  return next();
}

// Для тестов: сброс счётчиков.
export function _resetRateLimit() {
  hits.clear();
}
