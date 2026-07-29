// Роуты синхронизации /v1/sync/*. req.userId уже проставлен requireUser (глобально на /v1).
import { Router } from 'express';
import { pushSync, pullSync } from '../services/sync.js';

export const syncRouter = Router();

// POST /v1/sync/push — принять дельту клиента.
// body: { profile?, norms?, entries?[], foodCache?[] }
syncRouter.post('/v1/sync/push', async (req, res, next) => {
  try {
    const b = req.body ?? {};
    console.log(`[sync/push] user=${req.userId} profile=${!!b.profile} norms=${!!b.norms} entries=${(b.entries||[]).length} cache=${(b.foodCache||[]).length}`);
    await pushSync(req.userId, b);
    return res.json({ ok: true, serverTime: Date.now() });
  } catch (err) {
    console.error('[sync/push]', err.message);
    return next(err);
  }
});

// GET /v1/sync/pull?since=<epoch-ms> — отдать данные (full если since отсутствует).
syncRouter.get('/v1/sync/pull', async (req, res, next) => {
  try {
    const sinceRaw = req.query.since;
    const since = sinceRaw != null && sinceRaw !== '' ? Number(sinceRaw) : null;
    const data = await pullSync(req.userId, Number.isFinite(since) ? since : null);
    return res.json(data);
  } catch (err) {
    console.error('[sync/pull]', err.message);
    return next(err);
  }
});
