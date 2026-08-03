// Per-device rate-limit. Initially — in-memory (the only non-stateless place;
// replace with Redis for horizontal scaling — see ARCHITECTURE.md).
// Sliding window: no more than RATE_LIMIT_MAX requests per RATE_LIMIT_WINDOW_MS per device.
import { config } from '../config.js';
import { deviceIdFrom } from './auth.js';

// deviceId → array of request timestamps in the current window.
const hits = new Map();

// Periodic cleanup of stale entries so the Map does not grow indefinitely.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - config.rateLimit.windowMs;
  for (const [id, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    if (fresh.length === 0) hits.delete(id);
    else hits.set(id, fresh);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.(); // do not keep the process alive because of the timer

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

// For tests: reset counters.
export function _resetRateLimit() {
  hits.clear();
}
