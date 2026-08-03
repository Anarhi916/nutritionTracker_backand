// Cross-user nutrient cache on the backend. Key = normalizeKey(food_name_en).
// Stores ONLY server-generated data (the text pipeline). See ARCHITECTURE.md.
//
// normalizeKey is identical to the client DatabaseManager.normalizeKey:
// lowercased + trim + words sorted alphabetically + single spaces.

import { query } from '../db/pool.js';

// Key normalization — an EXACT copy of iOS normalizeKey (word order does not matter).
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
 * Looks up nutrients in the cache by English name (normalized).
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
 * Writes server-generated nutrients to the shared cache by keyEn.
 * UPSERT: a repeat write updates (fresher USDA/AI overwrites the old).
 * @param {string} foodNameEn
 * @param {object} nutrientsPer100g — 34 fields per 100 g
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
