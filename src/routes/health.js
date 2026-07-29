// GET /health — liveness (процесс жив). Статус БД — в теле (readiness-инфо).
// Возвращает 200, пока процесс жив; поле db показывает доступность Postgres.
import { Router } from 'express';
import { pingDb } from '../db/pool.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const dbOk = await pingDb();
  res.status(200).json({
    status: 'ok',
    db: dbOk ? 'up' : 'down',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
