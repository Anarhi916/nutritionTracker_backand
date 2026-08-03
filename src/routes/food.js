// Routes /v1/food/*: analyze (text), enrich (barcode), photo, dish.
import { Router } from 'express';
import {
  analyzeFoodText, analyzePhoto, enrichBarcode, analyzeDish,
} from '../services/pipeline.js';

export const foodRouter = Router();

/**
 * POST /v1/food/analyze
 * Body: { items: [{name, grams}], uiLang, useCache? }
 *   items  — already parsed by the client (name + grams; the client parses the weight).
 *   uiLang — English name of the UI language (e.g. "German"); default "English".
 * Response: { results: [{foodName, foodNameEn, weightGrams, nutrientsPer100g, fromCache}] }
 *   Nutrients per 100 g — the client scales them by weight itself.
 */
foodRouter.post('/v1/food/analyze', async (req, res, next) => {
  try {
    const { items, uiLang, useCache } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'items[] обязателен' });
    }
    // Normalize the input: name is required, grams is optional (0 = not specified).
    const norm = [];
    for (const it of items) {
      const name = typeof it?.name === 'string' ? it.name.trim() : '';
      if (!name) continue;
      const grams = Number(it?.grams);
      norm.push({ name, grams: Number.isFinite(grams) && grams > 0 ? grams : 0 });
    }
    if (norm.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'нет валидных items с name' });
    }

    const lang = typeof uiLang === 'string' && uiLang.trim() ? uiLang.trim() : 'English';
    const results = await analyzeFoodText(norm, lang, { useCache: useCache !== false });
    return res.json({ results });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'analyze_failed', message: err.message });
    }
    return next(err);
  }
});

/**
 * POST /v1/food/enrich — barcode. The client itself went to OFF (its own IP) and sends the result.
 * Body: { name, nutrientsPer100g }  (OFF nutrients per 100g, may be incomplete).
 * The server further enriches micros + fats (AI). Does NOT write to the shared cache (data from the client).
 * Response: { name, nutrientsPer100g }
 */
foodRouter.post('/v1/food/enrich', async (req, res, next) => {
  try {
    const { name, nutrientsPer100g } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'bad_request', message: 'name обязателен' });
    }
    const off = (nutrientsPer100g && typeof nutrientsPer100g === 'object') ? nutrientsPer100g : {};
    const result = await enrichBarcode(name.trim(), off);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /v1/food/photo — recognition from a photo. Pure AI, no USDA, no cache.
 * Body: { imageBase64, uiLang }  (JPEG in base64, without the data-URL prefix).
 * Response: { foodName, foodNameEn, weightGrams, nutrientsPer100g }
 */
foodRouter.post('/v1/food/photo', async (req, res, next) => {
  try {
    const { imageBase64, uiLang } = req.body ?? {};
    if (typeof imageBase64 !== 'string' || imageBase64.length < 100) {
      return res.status(400).json({ error: 'bad_request', message: 'imageBase64 обязателен' });
    }
    const lang = typeof uiLang === 'string' && uiLang.trim() ? uiLang.trim() : 'English';
    const result = await analyzePhoto(imageBase64, lang);
    return res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ error: 'photo_failed', message: err.message });
    }
    return next(err);
  }
});

/**
 * POST /v1/food/dish — whole dish via AI (for photos with a renamed item). No USDA, no cache.
 * Body: { dishName }
 * Response: { foodNameEn, nutrientsPer100g }
 */
foodRouter.post('/v1/food/dish', async (req, res, next) => {
  try {
    const { dishName } = req.body ?? {};
    if (typeof dishName !== 'string' || !dishName.trim()) {
      return res.status(400).json({ error: 'bad_request', message: 'dishName обязателен' });
    }
    const result = await analyzeDish(dishName.trim());
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});
