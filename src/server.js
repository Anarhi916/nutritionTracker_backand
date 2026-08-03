// Express server bootstrap. At this stage (task 2) — only /health and the skeleton.
// food/norms routes and auth middleware are wired up in tasks 5-8.
import express from 'express';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { foodRouter } from './routes/food.js';
import { normsRouter } from './routes/norms.js';
import { syncRouter } from './routes/sync.js';
import { authMiddleware } from './middleware/auth.js';
import { requireUser } from './middleware/requireUser.js';
import { rateLimitMiddleware } from './middleware/rateLimit.js';
import { closePool } from './db/pool.js';

const app = express();

// Body limit raised because of base64 photos in /v1/food/photo (see ARCHITECTURE.md).
app.use(express.json({ limit: '6mb' }));

// /health — no auth (liveness probe).
app.use('/', healthRouter);

// Authentication (login/refresh/logout) — public endpoints, BEFORE authMiddleware.
// (DELETE /v1/auth/account inside the router is protected by its own requireUser.)
app.use('/', authRouter);

// Lightweight log of incoming /v1/* (method, path, platform) — helps observe client traffic.
app.use('/v1', (req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path} platform=${req.get('X-Platform') ?? '-'}`);
  next();
});

// All /v1/* (except auth above) — behind attestation/dev-secret + rate-limit + user session.
// authMiddleware sets req.deviceId; requireUser sets req.userId (Bearer).
app.use('/v1', authMiddleware, rateLimitMiddleware, requireUser);

// /v1/* routes
app.use('/', foodRouter);
app.use('/', normsRouter);
app.use('/', syncRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Unified error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] необработанная ошибка:', err);
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, () => {
  console.log(
    `[server] NutritionTracker backend слушает :${config.port} (env=${config.nodeEnv}, auth=${config.auth.mode})`,
  );
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[server] получен ${signal}, завершаюсь...`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
