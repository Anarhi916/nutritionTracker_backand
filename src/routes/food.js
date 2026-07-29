// Роуты /v1/food/*: analyze (текст), enrich (штрихкод), photo, dish.
import { Router } from 'express';
import {
  analyzeFoodText, analyzePhoto, enrichBarcode, analyzeDish,
} from '../services/pipeline.js';

export const foodRouter = Router();

/**
 * POST /v1/food/analyze
 * Body: { items: [{name, grams}], uiLang, useCache? }
 *   items  — уже спарсенные клиентом (имя + граммы; вес парсит клиент).
 *   uiLang — English name языка UI (напр. "German"); дефолт "English".
 * Ответ: { results: [{foodName, foodNameEn, weightGrams, nutrientsPer100g, fromCache}] }
 *   Нутриенты на 100 г — клиент масштабирует на вес сам.
 */
foodRouter.post('/v1/food/analyze', async (req, res, next) => {
  try {
    const { items, uiLang, useCache } = req.body ?? {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'bad_request', message: 'items[] обязателен' });
    }
    // Нормализуем вход: name обязателен, grams опционален (0 = не указан).
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
 * POST /v1/food/enrich — штрихкод. Клиент сам сходил в OFF (свой IP), шлёт результат.
 * Body: { name, nutrientsPer100g }  (OFF-нутриенты на 100г, могут быть неполными).
 * Сервер дообогащает микро+жиры (AI). НЕ пишет в общий кэш (данные от клиента).
 * Ответ: { name, nutrientsPer100g }
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
 * POST /v1/food/photo — распознавание по фото. Чистый AI, без USDA, без кэша.
 * Body: { imageBase64, uiLang }  (JPEG в base64, без data-URL префикса).
 * Ответ: { foodName, foodNameEn, weightGrams, nutrientsPer100g }
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
 * POST /v1/food/dish — целое блюдо через AI (для фото со сменой имени). Без USDA, без кэша.
 * Body: { dishName }
 * Ответ: { foodNameEn, nutrientsPer100g }
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
