// Bootstrap Express-сервера. На этом этапе (задача 2) — только /health и каркас.
// Роуты food/norms и auth-middleware подключаются в задачах 5-8.
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

// Лимит тела поднят из-за base64-фото в /v1/food/photo (см. ARCHITECTURE.md).
app.use(express.json({ limit: '6mb' }));

// /health — без auth (liveness-проба).
app.use('/', healthRouter);

// Аутентификация (вход/refresh/logout) — публичные эндпоинты, ДО authMiddleware.
// (DELETE /v1/auth/account внутри роутера защищён своим requireUser.)
app.use('/', authRouter);

// Лёгкий лог входящих /v1/* (метод, путь, платформа) — помогает видеть трафик клиента.
app.use('/v1', (req, _res, next) => {
  console.log(`[req] ${req.method} ${req.path} platform=${req.get('X-Platform') ?? '-'}`);
  next();
});

// Все /v1/* (кроме auth выше) — за attestation/dev-secret + rate-limit + пользовательской сессией.
// authMiddleware ставит req.deviceId; requireUser ставит req.userId (Bearer).
app.use('/v1', authMiddleware, rateLimitMiddleware, requireUser);

// Роуты /v1/*
app.use('/', foodRouter);
app.use('/', normsRouter);
app.use('/', syncRouter);

// 404
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Единый обработчик ошибок
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

// Аккуратное завершение
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
