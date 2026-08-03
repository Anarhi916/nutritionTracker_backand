// POST /v1/norms — daily norms calculation (AI). No cache (individual). Auth — task 8.
import { Router } from 'express';
import { calculateNorms } from '../services/norms.js';

export const normsRouter = Router();

/**
 * Body: { gender:'male'|'female', age, weight(kg), height(cm), goals }
 * Response: { norms: {...34 nutrients...} }
 */
normsRouter.post('/v1/norms', async (req, res, next) => {
  try {
    const { gender, age, weight, height, goals } = req.body ?? {};
    const g = gender === 'male' || gender === 'female' ? gender : null;
    const ageN = Number(age);
    const weightN = Number(weight);
    const heightN = Number(height);
    if (!g || !Number.isFinite(ageN) || !Number.isFinite(weightN) || !Number.isFinite(heightN)) {
      return res.status(400).json({
        error: 'bad_request',
        message: 'gender(male|female), age, weight, height обязательны',
      });
    }
    const norms = await calculateNorms({
      gender: g, age: ageN, weight: weightN, height: heightN,
      goals: typeof goals === 'string' ? goals : '',
    });
    return res.json({ norms });
  } catch (err) {
    return next(err);
  }
});
