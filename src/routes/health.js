// GET /health — liveness (process is alive). DB status — in the body (readiness info).
// Returns 200 while the process is alive; the db field shows Postgres availability.
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
