// Text analysis orchestrator — a port of analyzeFoodText from iOS NutritionRepository.
// Differences from the client (recorded in ARCHITECTURE.md):
//   1. Cache ONLY by keyEn (no local RU cache on the server).
//   2. fat-details is called IMMEDIATELY on a miss before writing to the cache (fixes the asymmetry).
//   3. Response = nutrients per 100g + weight; the client scales it itself.
// The client parses the weight → the server receives items [{name, grams}] + uiLang.

import { config } from '../config.js';
import { callOpenRouterWithRetry } from './openrouter.js';
import { searchUsdaResponse } from './usdaSearch.js';
import { findInCache, saveToCache } from './cache.js';
import { NUTRIENT_ID } from '../db/nutrients.js';
import {
  buildIdentifyPrompt, buildUsdaQueriesPrompt, buildPickPrompt, buildVerifyPrompt,
  buildBatchNutrientPrompt, buildMicroFillPrompt, buildSingleDishPrompt, buildDairyPrompt,
  buildFatDetailsPrompt, buildNutrientsFromUsda, nutrientDataFromMap, fillMissingMicros,
  extractJSON, parseJSONMap, parseJSONArray, isDairyWithFatPercent, extractFatPercent,
  stripFatPercent, buildEnrichMicrosPrompt, buildPhotoPrompt, emptyNutrients,
} from './prompts.js';

const TEXT = config.models.text;

// British → American English (for USDA). Port of the list from iOS.
const BRITISH_TO_AMERICAN = [
  ['beetroot', 'beet'], ['aubergine', 'eggplant'], ['courgette', 'zucchini'],
  ['coriander leaf', 'cilantro'], ['capsicum', 'bell pepper'],
  ['rocket', 'arugula'], ['mangetout', 'snow peas'], ['swede', 'rutabaga'],
  ['broad bean', 'fava bean'], ['chickpea', 'garbanzo bean'],
  ['maize', 'corn'], ['prawn', 'shrimp'],
];

function toAmerican(name) {
  let n = name;
  for (const [br, am] of BRITISH_TO_AMERICAN) {
    n = n.replace(new RegExp(br, 'gi'), am);
  }
  return n;
}

// negationCleaned: remove "without/no/not/minus/free from X", collapse spaces.
function negationClean(name) {
  return name
    .replace(/\b(without|no|not|minus|free\s+from)\s+\w+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// >5 significant words → composite dish, skip USDA.
function isCompositeDish(negationCleaned) {
  const stop = ['with', 'and', 'the', 'from', 'for'];
  const significant = negationCleaned.toLowerCase().split(/\s+/)
    .filter((w) => w.length >= 3 && !stop.includes(w));
  return significant.length > 5;
}

// UsdaCandidateBrief from a USDA food (null if calories == 0).
function usdaCandidateBrief(food) {
  const nMap = new Map();
  for (const fn of food.foodNutrients ?? []) {
    if (fn.nutrientId != null && fn.value != null) nMap.set(fn.nutrientId, fn.value);
  }
  const cal = nMap.get(NUTRIENT_ID.ENERGY) ?? 0;
  if (cal <= 0) return null;
  return {
    fdcId: food.fdcId,
    description: food.description ?? '',
    dataType: food.dataType ?? '',
    calories: cal,
    protein: nMap.get(NUTRIENT_ID.PROTEIN) ?? 0,
    fat: nMap.get(NUTRIENT_ID.FAT) ?? 0,
    carbs: nMap.get(NUTRIENT_ID.CARBS) ?? 0,
  };
}

// ── AI wrappers (text model) ──

async function runIdentify(descriptionForAi, uiLang) {
  const prompt = buildIdentifyPrompt(descriptionForAi, uiLang);
  const text = await callOpenRouterWithRetry({
    messages: [{ role: 'user', content: prompt }], models: TEXT,
  });
  // parseIdentityList: array or a single object
  const json = extractJSON(text);
  let parsed;
  try { parsed = JSON.parse(json); } catch { return []; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({
      foodName: o.food_name ?? '',
      foodNameEn: o.food_name_en ?? '',
      weightGrams: Number(o.weight_grams) || 0,
    }));
}

async function generateUsdaSearchQueries(queryRu, queryEn) {
  try {
    const text = await callOpenRouterWithRetry({
      messages: [{ role: 'user', content: buildUsdaQueriesPrompt(queryRu, queryEn) }], models: TEXT,
    });
    const parsed = JSON.parse(extractJSON(text));
    let arr = Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray) ?? [];
    arr = arr.filter((s) => typeof s === 'string' && s.trim());
    const dedup = [];
    for (const s of arr) if (!dedup.some((x) => x.toLowerCase() === s.toLowerCase())) dedup.push(s);
    const result = dedup.slice(0, 3);
    return result.length ? result : [queryEn];
  } catch {
    return [queryEn];
  }
}

async function askAiToPickUsdaCandidate(queryRu, queryEn, candidates) {
  if (candidates.length === 0) return null;
  const list = candidates.map((c, i) =>
    `${i + 1}. [fdcId=${c.fdcId}] [${c.dataType}] "${c.description}" — ` +
    `cal=${c.calories.toFixed(0)}, P=${c.protein.toFixed(1)}, F=${c.fat.toFixed(1)}, C=${c.carbs.toFixed(1)}`,
  ).join('\n');
  try {
    const text = await callOpenRouterWithRetry({
      messages: [{ role: 'user', content: buildPickPrompt(queryRu, queryEn, list) }], models: TEXT,
    });
    const map = parseJSONMap(text);
    const raw = map.fdc_id;
    const id = typeof raw === 'number' ? raw : (typeof raw === 'string' ? parseInt(raw, 10) : null);
    if (id == null || !candidates.some((c) => c.fdcId === id)) return null; // guard against hallucinations
    return id;
  } catch {
    return null;
  }
}

async function verifyUsdaPick(queryRu, queryEn, pick) {
  try {
    const text = await callOpenRouterWithRetry({
      messages: [{ role: 'user', content: buildVerifyPrompt(queryRu, queryEn, pick) }], models: TEXT,
    });
    const map = parseJSONMap(text);
    const bool = (k) => {
      const v = map[k];
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') return v.toLowerCase() === 'true';
      return false;
    };
    return bool('is_same_product') && bool('macros_plausible'); // both → true
  } catch {
    return false; // error = REJECT
  }
}

// One USDA search round: search → accumulate candidates → pick (2 attempts) → verify.
async function runOneRound(query, queryRu, queryEn, allCandidates) {
  try {
    const res = await searchUsdaResponse(query, 25);
    for (const f of res.foods ?? []) {
      if (f.fdcId != null && !allCandidates.has(f.fdcId)) allCandidates.set(f.fdcId, f);
    }
    const briefsById = new Map();
    for (const food of allCandidates.values()) {
      const brief = usdaCandidateBrief(food);
      if (brief) briefsById.set(brief.fdcId, brief);
    }
    if (briefsById.size === 0) return null;

    const excluded = new Set();
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = [...briefsById.values()].filter((b) => !excluded.has(b.fdcId));
      if (remaining.length === 0) break;
      const pickedId = await askAiToPickUsdaCandidate(queryRu, queryEn, remaining);
      if (process.env.PIPELINE_DEBUG) console.error(`[dbg]   round "${query}": ${remaining.length} cand, pick=${pickedId ?? 'null'}`);
      if (pickedId == null) break;
      const pickedBrief = briefsById.get(pickedId);
      if (!pickedBrief) break;
      const ok = await verifyUsdaPick(queryRu, queryEn, pickedBrief);
      if (process.env.PIPELINE_DEBUG) console.error(`[dbg]   verify "${pickedBrief.description}" → ${ok}`);
      if (ok) {
        return allCandidates.get(pickedId);
      }
      excluded.add(pickedId);
    }
    return null;
  } catch {
    return null;
  }
}

// enrichFatDetails — USDA (local) then AI, with validation. Port of the iOS logic.
export async function enrichFatDetails(nutrients, foodNameEn) {
  if ((nutrients.fat ?? 0) <= 0) return nutrients;
  if (!(nutrients.monounsaturated_fat === 0 && nutrients.polyunsaturated_fat === 0)) return nutrients;

  const current = { ...nutrients };

  // Step 1: local USDA
  try {
    const res = await searchUsdaResponse(foodNameEn, 5);
    const food = (res.foods ?? []).find((f) =>
      (f.foodNutrients ?? []).some((n) => n.nutrientId === NUTRIENT_ID.ENERGY && (n.value ?? 0) > 0));
    if (food) {
      const nMap = new Map();
      for (const fn of food.foodNutrients ?? []) {
        if (fn.nutrientId != null && fn.value != null) nMap.set(fn.nutrientId, fn.value);
      }
      if (current.saturated_fat === 0) current.saturated_fat = nMap.get(NUTRIENT_ID.SATURATED_FAT) ?? 0;
      if (current.monounsaturated_fat === 0) current.monounsaturated_fat = nMap.get(NUTRIENT_ID.MONOUNSATURATED_FAT) ?? 0;
      if (current.polyunsaturated_fat === 0) current.polyunsaturated_fat = nMap.get(NUTRIENT_ID.POLYUNSATURATED_FAT) ?? 0;
      if (current.cholesterol === 0) current.cholesterol = nMap.get(NUTRIENT_ID.CHOLESTEROL) ?? 0;
    }
  } catch { /* silently */ }

  // Step 2: AI if still empty
  if (current.monounsaturated_fat === 0 || current.polyunsaturated_fat === 0) {
    try {
      const text = await callOpenRouterWithRetry({
        messages: [{ role: 'user', content: buildFatDetailsPrompt(foodNameEn, nutrients.fat) }], models: TEXT,
      });
      const map = parseJSONMap(text);
      const g = (k) => (typeof map[k] === 'number' ? map[k] : 0);
      if (current.saturated_fat === 0) current.saturated_fat = g('saturated_fat');
      if (current.monounsaturated_fat === 0) current.monounsaturated_fat = g('monounsaturated_fat');
      if (current.polyunsaturated_fat === 0) current.polyunsaturated_fat = g('polyunsaturated_fat');
      if (current.cholesterol === 0) current.cholesterol = g('cholesterol');
    } catch { /* silently */ }
  }

  // Validation: sum of fractions <= total fat
  const totalFat = current.fat;
  const fatSum = current.saturated_fat + current.monounsaturated_fat + current.polyunsaturated_fat;
  if (fatSum > totalFat && totalFat > 0) {
    const scale = totalFat / fatSum;
    current.saturated_fat *= scale;
    current.monounsaturated_fat *= scale;
    current.polyunsaturated_fat *= scale;
  }
  current.saturated_fat = Math.min(current.saturated_fat, totalFat);
  current.monounsaturated_fat = Math.min(current.monounsaturated_fat, totalFat);
  current.polyunsaturated_fat = Math.min(current.polyunsaturated_fat, totalFat);

  // Sentinel — so as not to run enrichment again
  if (current.monounsaturated_fat === 0 && current.polyunsaturated_fat === 0) {
    current.monounsaturated_fat = 0.0001;
    current.polyunsaturated_fat = 0.0001;
  }
  return current;
}

// correctDairyMacros — GOST correction of macros by fat %. Port of the iOS logic.
async function correctDairyMacros(nutrients, foodNameRu) {
  const percent = extractFatPercent(foodNameRu);
  if (percent == null) return nutrients;
  try {
    const text = await callOpenRouterWithRetry({
      messages: [{ role: 'user', content: buildDairyPrompt(foodNameRu, percent) }], models: TEXT,
    });
    const map = parseJSONMap(text);
    const protein = typeof map.protein === 'number' ? map.protein : null;
    const fat = typeof map.fat === 'number' ? map.fat : 0;
    const carbs = typeof map.carbs === 'number' ? map.carbs : 0;
    if (protein == null || protein <= 0) return nutrients;
    const calories = typeof map.calories === 'number' ? map.calories : protein * 4 + fat * 9 + carbs * 4;

    // Safety net: fat must match the percent from the name
    const finalFat = Math.abs(fat - percent) / Math.max(percent, 0.5) > 0.15 ? percent : fat;
    const finalCalories = Math.abs(finalFat - fat) > 0.01
      ? protein * 4 + finalFat * 9 + carbs * 4 : calories;

    const corrected = { ...nutrients };
    const oldFat = nutrients.fat;
    corrected.protein = protein;
    corrected.fat = finalFat;
    corrected.carbs = carbs;
    corrected.calories = finalCalories;
    if (oldFat > 0) {
      const scale = finalFat / oldFat;
      corrected.saturated_fat = nutrients.saturated_fat * scale;
      corrected.monounsaturated_fat = nutrients.monounsaturated_fat * scale;
      corrected.polyunsaturated_fat = nutrients.polyunsaturated_fat * scale;
      corrected.cholesterol = nutrients.cholesterol * scale;
    }
    return corrected;
  } catch {
    return nutrients;
  }
}

// analyzeSingleDish (last-resort, no cache) — whole dish via AI. Returns per100g.
export async function analyzeSingleDish(dishName) {
  const text = await callOpenRouterWithRetry({
    messages: [{ role: 'user', content: buildSingleDishPrompt(dishName) }], models: TEXT,
  });
  const map = parseJSONMap(text);
  const nameEn = typeof map.food_name_en === 'string' ? map.food_name_en : dishName;
  let per100g = nutrientDataFromMap(map);
  if (isDairyWithFatPercent(dishName, nameEn)) {
    per100g = await correctDairyMacros(per100g, dishName);
  }
  return { nameEn, per100g };
}

/**
 * Main text analysis orchestrator.
 * @param {Array<{name:string, grams:number}>} items — already parsed by the client.
 * @param {string} uiLang — English name of the UI language (e.g. "German").
 * @param {object} [opts] — { useCache=true }
 * @returns {Promise<Array>} results [{foodName, foodNameEn, weightGrams, nutrientsPer100g, fromCache}]
 */
export async function analyzeFoodText(items, uiLang, { useCache = true } = {}) {
  // Step 1: identify (ALWAYS) — descriptionForAi from items (weight as a hint).
  const descriptionForAi = items
    .map(({ name, grams }) => (grams > 0 ? `${name} ${Math.round(grams)}г` : name))
    .join(', ');

  const identities = await runIdentify(descriptionForAi, uiLang);
  if (identities.length === 0) {
    const err = new Error('Не удалось распознать продукты из описания');
    err.status = 422;
    throw err;
  }

  const cachedResults = [];
  const aiPending = [];

  // Cache lookup by keyEn (the only cache on the server).
  for (const id of identities) {
    const nameRu = id.foodName || descriptionForAi;
    const nameEn = id.foodNameEn || id.foodName;
    const weight = id.weightGrams > 0 ? id.weightGrams : 100.0;

    const cached = useCache ? await findInCache(nameEn) : null;
    if (cached) {
      let enriched = cached.nutrients;
      enriched = await enrichFatDetails(enriched, nameEn);
      // update the cache if fat-details were topped up
      if (JSON.stringify(enriched) !== JSON.stringify(cached.nutrients)) {
        await saveToCache(nameEn, enriched, cached.source ?? 'usda');
      }
      cachedResults.push({ foodNameRu: nameRu, foodNameEn: nameEn, weight, nutrientsPer100g: enriched, fromCache: true });
    } else {
      aiPending.push({ foodNameRu: nameRu, foodNameEn: nameEn, weight, nutrientsPer100g: null });
    }
  }

  // Step 2: USDA loop for aiPending.
  for (const item of aiPending) {
    const isDairyPct = isDairyWithFatPercent(item.foodNameRu, item.foodNameEn);
    let nameForSearch = isDairyPct ? stripFatPercent(item.foodNameEn) : item.foodNameEn;
    nameForSearch = toAmerican(nameForSearch);
    const negationCleaned = negationClean(nameForSearch);

    if (isCompositeDish(negationCleaned)) continue; // → Step 3

    const queryRu = isDairyPct ? stripFatPercent(item.foodNameRu) : item.foodNameRu;
    const queryEn = isDairyPct ? stripFatPercent(item.foodNameEn) : item.foodNameEn;

    let searchQueries;
    if (isDairyPct) {
      searchQueries = [negationCleaned || nameForSearch];
    } else {
      const generated = await generateUsdaSearchQueries(queryRu, queryEn);
      searchQueries = generated.length ? generated : [negationCleaned || nameForSearch];
    }
    if (process.env.PIPELINE_DEBUG) console.error(`[dbg] "${item.foodNameEn}" → queries:`, searchQueries);

    const allCandidates = new Map();
    let selectedFood = null;
    for (const q of searchQueries) {
      selectedFood = await runOneRound(q, queryRu, queryEn, allCandidates);
      if (selectedFood) break;
    }

    // Deterministic fallback: if the AI phrases produced no candidate, and the query contains
    // a state word (baked/roasted/…), try the USDA-standard "cooked" and the bare name.
    // Fixes fish/meat where USDA indexes only "cooked" (e.g. tuna baked → tuna cooked).
    if (!selectedFood) {
      const tokens = negationCleaned.toLowerCase().split(/\s+/).filter(Boolean);
      const stateWords = ['baked', 'roasted', 'fried', 'grilled', 'broiled', 'braised', 'stewed'];
      const hasState = tokens.some((t) => stateWords.includes(t));
      const ingredientOnly = tokens.filter((t) => !stateWords.includes(t)).join(' ');
      const extraQueries = [];
      if (hasState && ingredientOnly) {
        extraQueries.push(`${ingredientOnly} cooked`, ingredientOnly);
      }
      for (const q of extraQueries) {
        selectedFood = await runOneRound(q, queryRu, queryEn, allCandidates);
        if (selectedFood) break;
      }
      if (process.env.PIPELINE_DEBUG && extraQueries.length) {
        console.error(`[dbg] fallback queries:`, extraQueries, '→', selectedFood?.description ?? 'НЕТ');
      }
    }
    if (process.env.PIPELINE_DEBUG) console.error(`[dbg] selectedFood:`, selectedFood?.description ?? 'НЕТ (→AI fallback)');

    if (selectedFood) {
      const nutrients = buildNutrientsFromUsda(selectedFood, nameForSearch, negationCleaned);
      if (process.env.PIPELINE_DEBUG) console.error(`[dbg] buildNutrientsFromUsda:`, nutrients ? `OK F=${nutrients.fat}` : 'ОТБРАКОВАН (Atwater/branded)');
      if (nutrients) item.nutrientsPer100g = nutrients;
    }
  }

  // Step 3: batch AI for products without USDA.
  const needAi = aiPending.filter((it) => it.nutrientsPer100g == null);
  if (needAi.length > 0) {
    try {
      const foodsList = needAi.map((it, i) => `${i + 1}. ${it.foodNameEn} (per 100g)`).join('\n');
      const text = await callOpenRouterWithRetry({
        messages: [{ role: 'user', content: buildBatchNutrientPrompt(foodsList, needAi.length) }], models: TEXT,
      });
      const parsed = parseJSONArray(text);
      needAi.forEach((it, i) => { if (i < parsed.length) it.nutrientsPer100g = nutrientDataFromMap(parsed[i]); });
    } catch { /* log omitted */ }
  }

  // Step 4: micro-fill for USDA products with iodine < 0.01.
  const needMicros = aiPending.filter((it) => it.nutrientsPer100g && (it.nutrientsPer100g.iodine ?? 0) < 0.01);
  if (needMicros.length > 0) {
    try {
      const foodsList = needMicros.map((it, i) => `${i + 1}. ${it.foodNameEn}`).join('\n');
      const text = await callOpenRouterWithRetry({
        messages: [{ role: 'user', content: buildMicroFillPrompt(foodsList, needMicros.length) }], models: TEXT,
      });
      const parsed = parseJSONArray(text);
      needMicros.forEach((it, i) => { if (i < parsed.length) it.nutrientsPer100g = fillMissingMicros(it.nutrientsPer100g, parsed[i]); });
    } catch { /* log omitted */ }
  }

  // Step 5: last-resort + dairy correction + FAT-DETAILS on miss (our fix) + write to cache.
  for (const item of aiPending) {
    let source = 'usda';
    if (item.nutrientsPer100g == null) {
      try {
        const { per100g } = await analyzeSingleDish(item.foodNameRu);
        item.nutrientsPer100g = per100g;
        source = 'ai';
      } catch { /* log omitted */ }
    } else if (needAi.includes(item)) {
      source = 'ai';
    }

    if (item.nutrientsPer100g && isDairyWithFatPercent(item.foodNameRu, item.foodNameEn)) {
      item.nutrientsPer100g = await correctDairyMacros(item.nutrientsPer100g, item.foodNameRu);
    }

    // ASYMMETRY FIX: fat-details immediately on a miss, before writing to the cache → a complete write.
    if (item.nutrientsPer100g) {
      item.nutrientsPer100g = await enrichFatDetails(item.nutrientsPer100g, item.foodNameEn);
      await saveToCache(item.foodNameEn, item.nutrientsPer100g, source);
    }
  }

  // Build results — nutrients per 100g (the client scales them itself).
  const allItems = [...cachedResults, ...aiPending];
  const zeroMacroOk = ['вода', 'water', 'чай', 'tea', 'кофе', 'coffee', 'herb', 'spice', 'vinegar', 'gelatin'];
  const results = [];
  for (const item of allItems) {
    const per100g = item.nutrientsPer100g;
    if (!per100g) continue;
    const hasNutrients = per100g.calories > 0 || per100g.protein > 0 || per100g.fat > 0 || per100g.carbs > 0;
    const isKnownZero = zeroMacroOk.some((z) =>
      item.foodNameRu.toLowerCase().includes(z) || item.foodNameEn.toLowerCase().includes(z));
    if (!hasNutrients && !isKnownZero) continue;
    results.push({
      foodName: item.foodNameRu,
      foodNameEn: item.foodNameEn,
      weightGrams: item.weight,
      nutrientsPer100g: per100g,
      fromCache: item.fromCache ?? false,
    });
  }

  if (results.length === 0) {
    const err = new Error('Не удалось получить данные о нутриентах для введённых продуктов');
    err.status = 422;
    throw err;
  }
  return results;
}

// ── enrichMicros (single) — tops up missing micros with a single AI call.
// Port of enrichMicrosWithAIPublic. Asks ONLY for the missing ones (==0, iodine<0.01).
export async function enrichMicros(nutrients, foodNameEn) {
  const { prompt } = buildEnrichMicrosPrompt(nutrients, foodNameEn);
  if (!prompt) return nutrients; // nothing is missing
  try {
    const text = await callOpenRouterWithRetry({
      messages: [{ role: 'user', content: prompt }], models: TEXT,
    });
    const map = parseJSONMap(text);
    return fillMissingMicros(nutrients, map);
  } catch {
    return nutrients;
  }
}

/**
 * Photo: AI recognizes name+weight+nutrients. Pure AI, NO USDA, NO cache.
 * @param {string} imageBase64 — JPEG in base64 (without the data-URL prefix).
 * @param {string} uiLang — English name of the UI language.
 * @returns {Promise<{foodName, foodNameEn, weightGrams, nutrientsPer100g}>}
 */
export async function analyzePhoto(imageBase64, uiLang) {
  const prompt = buildPhotoPrompt(uiLang);
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
    ],
  }];
  const text = await callOpenRouterWithRetry({ messages, models: config.models.photo });
  let map;
  try {
    map = parseJSONMap(text);
  } catch {
    // The model did not return JSON (e.g. the photo is not food) → a clear error to the client.
    const err = new Error('Не удалось распознать еду на фото');
    err.status = 422;
    throw err;
  }
  const foodName = typeof map.food_name === 'string' && map.food_name ? map.food_name : 'Блюдо';
  const foodNameEn = typeof map.food_name_en === 'string' && map.food_name_en ? map.food_name_en : foodName;
  const weightGrams = typeof map.weight_grams === 'number' && map.weight_grams > 0 ? map.weight_grams : 200.0;
  const nutrientsPer100g = nutrientDataFromMap(map);
  return { foodName, foodNameEn, weightGrams, nutrientsPer100g };
}

/**
 * Barcode: enrichment of OFF data received by the client. We do NOT write to the shared cache
 * (data from the client = untrusted). Port of the tail of lookupBarcodeWithCache (after OFF).
 * @param {string} name — product name (from OFF).
 * @param {object} offNutrients — nutrients per 100g from OFF (may be incomplete/zero).
 * @returns {Promise<{name, nutrientsPer100g}>}
 */
export async function enrichBarcode(name, offNutrients) {
  let per100g = { ...emptyNutrients(), ...offNutrients };

  // Zero macros → fallback to AI (whole dish by name).
  if (per100g.calories === 0 && per100g.protein === 0 && per100g.fat === 0 && per100g.carbs === 0) {
    try {
      const { per100g: aiPer100g } = await analyzeSingleDish(name);
      per100g = aiPer100g;
    } catch { /* keep the OFF data as is */ }
  }

  // Enrich the missing micros (OFF rarely provides vitamins/minerals).
  per100g = await enrichMicros(per100g, name);
  // Enrich the fat breakdown.
  per100g = await enrichFatDetails(per100g, name);

  return { name, nutrientsPer100g: per100g };
}

/**
 * Whole dish via AI (for photos with a renamed item). NO USDA, NO cache.
 * A wrapper over analyzeSingleDish. Returns nutrients per 100g.
 * @param {string} dishName
 * @returns {Promise<{foodNameEn, nutrientsPer100g}>}
 */
export async function analyzeDish(dishName) {
  const { nameEn, per100g } = await analyzeSingleDish(dishName);
  return { foodNameEn: nameEn, nutrientsPer100g: per100g };
}
