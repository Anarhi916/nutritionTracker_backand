// Кросс-юзерный кэш нутриентов на бэкенде. Ключ = normalizeKey(food_name_en).
// Хранит ТОЛЬКО server-generated данные (текстовый пайплайн). См. ARCHITECTURE.md.
//
// normalizeKey идентичен клиентскому DatabaseManager.normalizeKey:
// lowercased + trim + слова отсортированы по алфавиту + одиночные пробелы.

import { query } from '../db/pool.js';

// Нормализация ключа — ТОЧНАЯ копия iOS normalizeKey (порядок слов не важен).
export function normalizeKey(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Ищет нутриенты в кэше по английскому имени (нормализованному).
 * @param {string} foodNameEn
 * @returns {Promise<{nutrients:object, source:string}|null>}
 */
export async function findInCache(foodNameEn) {
  const keyEn = normalizeKey(foodNameEn);
  if (!keyEn) return null;
  const { rows } = await query(
    'SELECT nutrients, source FROM food_cache WHERE key_en = $1',
    [keyEn],
  );
  if (rows.length === 0) return null;
  return { nutrients: rows[0].nutrients, source: rows[0].source };
}

/**
 * Пишет server-generated нутриенты в общий кэш по keyEn.
 * UPSERT: повторная запись обновляет (свежее USDA/AI перезаписывает старое).
 * @param {string} foodNameEn
 * @param {object} nutrientsPer100g — 34 поля на 100 г
 * @param {string} source — 'usda' | 'ai'
 */
export async function saveToCache(foodNameEn, nutrientsPer100g, source) {
  const keyEn = normalizeKey(foodNameEn);
  if (!keyEn) return;
  await query(
    `INSERT INTO food_cache (key_en, nutrients, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (key_en) DO UPDATE SET nutrients = EXCLUDED.nutrients,
       source = EXCLUDED.source, created_at = now()`,
    [keyEn, JSON.stringify(nutrientsPer100g), source],
  );
}
