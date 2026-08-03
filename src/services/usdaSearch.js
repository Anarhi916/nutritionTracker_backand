// Local search over the USDA copy in Postgres. Replaces the network call
// GET /fdc/v1/foods/search and builds a BYTE-IDENTICAL UsdaSearchResponse.
//
// Ranking task: the desired product must land in the top (the client/pipeline
// then picks from the top-25 via AI). USDA describes food as
// "Main-ingredient, modifier, modifier" — the main word comes first.
//
// See ARCHITECTURE.md (self-host USDA), db/nutrients.js (nutrient metadata).

import { query } from '../db/pool.js';
import { NUTRIENT_BY_ID } from '../db/nutrients.js';

// Stop-words that should not narrow/distort the search.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'with', 'without', 'in', 'on',
]);

// Cooking-state words. A match on them is a strong signal (raw≠cooked
// changes nutrients drastically). If the query specifies a state, and the candidate has
// the OPPOSITE — we penalize; if it matches — a bonus.
const STATE_WORDS = new Set([
  'raw', 'cooked', 'boiled', 'roasted', 'fried', 'baked', 'grilled',
  'braised', 'steamed', 'stewed', 'dried', 'dehydrated', 'canned', 'frozen',
  'smoked', 'broiled',
]);

// Words that mark composite dishes/processed products. If the query is a pure
// ingredient (none of these words) but the candidate contains them — a light penalty, so that
// the base form ("Egg, whole") outranks dishes ("Egg burrito", "Bread, egg").
const DISH_WORDS = new Set([
  'salad', 'sandwich', 'burrito', 'soup', 'cake', 'pie', 'bread', 'roll',
  'bagel', 'bagels', 'muffin', 'cookie', 'cookies', 'nuggets', 'nugget', 'creamed',
  'deviled', 'substitute', 'eggnog', 'strudel', 'juice', 'chips', 'split',
  'pizza', 'taco', 'wrap', 'casserole', 'dip', 'sauce', 'spread', 'bar',
  'snacks', 'snack', 'cereal', 'flavored', 'lunchmeat', 'oil', 'glazed',
  'dry', 'mix',
]);
// SR Legacy — the most complete reference of base products; Foundation — accurate new ones;
// FNDDS — dishes/composites. The order only affects the tie-break.
const DATA_TYPE_WEIGHT = {
  sr_legacy_food: 1.0,
  foundation_food: 0.98,
  survey_fndds_food: 0.96,
};

// Synonyms for frequent mismatches "everyday word ↔ USDA term".
const SYNONYMS = new Map([
  ['oatmeal', 'oats'],
  ['aubergine', 'eggplant'],
  ['courgette', 'zucchini'],
  ['prawns', 'shrimp'],
  ['prawn', 'shrimp'],
]);

// "Variant" words that lower base relevance if absent from the query
// (light/fat-free/reduced — not the base form of the product).
const VARIANT_WORDS = new Set([
  'light', 'lite', 'lowfat', 'nonfat', 'fat-free', 'reduced', 'diet',
  'unsweetened', 'sweetened', 'imitation', 'free', 'bran', 'raab',
]);

// String normalization: lower, strip punctuation → array of words + synonyms.
function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SYNONYMS.get(w) ?? w);
}

// Primitive stemming to match singular/plural and -ed/-ing forms.
// carrot↔carrots, tomato↔tomatoes, boil↔boiled. Not linguistically accurate —
// enough for stems to match.
function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  return s;
}

// Significant query tokens (without stop-words).
function significantTokens(tokens) {
  return tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

// Match level of two words: 2 = exact/stem, 1 = prefix, 0 = none.
// Exact (egg==egg, carrot~carrots) is stronger than prefix (egg~eggnog).
function wordMatchLevel(a, b) {
  if (a === b) return 2;
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return 2;
  if (sa.length >= 3 && sb.length >= 3 && (sa.startsWith(sb) || sb.startsWith(sa))) {
    return 1;
  }
  return 0;
}

// Scoring of a single candidate against the query tokens.
// Returns a number (higher = better).
function scoreCandidate(descTokens, queryTokens, dataType, trigramSim) {
  if (queryTokens.length === 0) return 0;

  let exactHits = 0; // exact/stem match of a whole word
  let prefixHits = 0; // prefix (egg~eggnog) — weaker
  let substringHits = 0;
  let firstMatchIdx = -1;
  let firstMatchLevel = 0;

  // Ingredient tokens (not state words): they are what determine whether this is the right product.
  // State (baked/cooked) — a separate signal below. This fixes "tuna baked": a candidate
  // with no ingredient match (e.g. "Banana baked") gets a zero ingredientRatio
  // and loses to "Fish, tuna, cooked" (same ingredient, different state).
  const ingredientTokens = queryTokens.filter((t) => !STATE_WORDS.has(t));
  let ingredientHits = 0;

  for (const qt of queryTokens) {
    let matchedIdx = -1;
    let bestLevel = 0;
    for (let i = 0; i < descTokens.length; i++) {
      const lvl = wordMatchLevel(descTokens[i], qt);
      if (lvl > bestLevel) {
        bestLevel = lvl;
        matchedIdx = i;
        if (lvl === 2) break; // exact — best, do not search further
      }
    }
    let hitStrength = 0;
    if (bestLevel === 2) { exactHits += 1; hitStrength = 1; }
    else if (bestLevel === 1) { prefixHits += 1; hitStrength = 0.6; }
    else {
      const idx = descTokens.findIndex((dt) => dt.includes(qt) || qt.includes(dt));
      if (idx >= 0) {
        substringHits += 1;
        matchedIdx = idx;
        hitStrength = 0.4;
      }
    }
    if (!STATE_WORDS.has(qt)) ingredientHits += hitStrength;
    if (qt === queryTokens[0] && matchedIdx >= 0) {
      firstMatchIdx = matchedIdx;
      firstMatchLevel = bestLevel;
    }
  }

  // Share of matched INGREDIENTS (the main signal of product identity).
  // If there are no ingredients in the query (only state) — fall back to all tokens.
  const ingredientRatio = ingredientTokens.length > 0
    ? ingredientHits / ingredientTokens.length
    : (exactHits + prefixHits * 0.6 + substringHits * 0.4) / Math.max(queryTokens.length, 1);
  const matchRatio = ingredientRatio;

  // A candidate without a single ingredient match — almost certainly the wrong product.
  // Zero it out so that "Banana baked" does not surface for "tuna baked".
  if (ingredientTokens.length > 0 && ingredientHits === 0) return 0;

  // Bonus for an early match of the main word. We amplify it if the match is EXACT
  // (otherwise "Eggnog" at position 0 should not outrank "Egg, whole" by position).
  const posLevelMul = firstMatchLevel === 2 ? 1.0 : 0.4;
  let posBonus = 0;
  if (firstMatchIdx === 0) posBonus = 0.35;
  else if (firstMatchIdx === 1) posBonus = 0.28;
  else if (firstMatchIdx === 2) posBonus = 0.12;
  else if (firstMatchIdx > 2) posBonus = 0.04;
  posBonus *= posLevelMul;

  // A short description, where almost all words are from the query, is more relevant than a long one.
  // BUT we do not penalize long canonical entries if all query tokens are found.
  const coverage = (exactHits + prefixHits) / Math.max(descTokens.length, 1);

  // Bonus for full query coverage (all significant tokens found as whole words).
  const allTokensHit = exactHits + prefixHits >= queryTokens.length;
  const fullMatchBonus = allTokensHit ? 0.4 : 0;

  // Cooking-state signal: raw/cooked/boiled...
  const descSet = new Set(descTokens);
  let stateSignal = 0;
  for (const qt of queryTokens) {
    if (STATE_WORDS.has(qt)) {
      if (descSet.has(qt)) {
        stateSignal += 0.3; // the requested state is present
      } else {
        // a state was requested, but the candidate has a DIFFERENT state → penalty
        const hasOtherState = descTokens.some(
          (dt) => STATE_WORDS.has(dt) && dt !== qt,
        );
        if (hasOtherState) stateSignal -= 0.25;
      }
    }
  }

  const dtWeight = DATA_TYPE_WEIGHT[dataType] ?? 0.9;

  // Penalty for dish words, if the query is a pure ingredient (no dish words).
  const queryIsPlain = !queryTokens.some((t) => DISH_WORDS.has(t));
  let dishPenalty = 0;
  if (queryIsPlain) {
    for (const dt of descTokens) {
      if (DISH_WORDS.has(dt)) dishPenalty -= 0.18;
    }
  }

  // Penalty for variant words (light/reduced/nonfat), if absent from the query —
  // the base form of the product should win over dietary variants.
  let variantPenalty = 0;
  for (const dt of descTokens) {
    if (VARIANT_WORDS.has(dt) && !queryTokens.includes(dt)) variantPenalty -= 0.12;
  }

  const score =
    matchRatio * 1.0 +
    fullMatchBonus +
    posBonus +
    coverage * 0.25 +
    stateSignal +
    dishPenalty +
    variantPenalty +
    trigramSim * 0.25;

  return score * dtWeight;
}

/**
 * Search products in the local USDA database.
 * @param {string} q — search query (English, USDA-style).
 * @param {number} pageSize — max candidates (default 25, as in the client).
 * @returns {Promise<Array<{fdcId,description,dataType,score}>>} ranked candidates.
 */
export async function searchFoods(q, pageSize = 25) {
  const allTokens = tokenize(q);
  const queryTokens = significantTokens(allTokens);

  if (queryTokens.length === 0) return [];

  // SQL pre-filter: descriptions containing at least one token STEM (stem, OR),
  // + a trigram-similarity threshold as insurance against typos/word forms.
  // LIKE by stem (carrot → '%carrot%' catches 'carrots'). Exact scoring — in JS.
  // We pull an expanded pool (up to 400) so JS ranking picks the best.
  const stems = queryTokens.map((t) => stem(t));
  const likeClauses = stems.map((_, i) => `description ILIKE $${i + 2}`);
  const params = [q, ...stems.map((t) => `%${t}%`)];
  const sql = `
    SELECT fdc_id, description, data_type,
           similarity(lower(description), lower($1)) AS sim
    FROM foods
    WHERE (${likeClauses.join(' OR ')})
       OR similarity(lower(description), lower($1)) > 0.2
    ORDER BY sim DESC
    LIMIT 400
  `;
  const { rows } = await query(sql, params);

  const scored = rows.map((r) => {
    const descTokens = tokenize(r.description);
    const score = scoreCandidate(
      descTokens,
      queryTokens,
      r.data_type,
      parseFloat(r.sim) || 0,
    );
    return {
      fdcId: r.fdc_id,
      description: r.description,
      dataType: r.data_type,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, pageSize);
}

/**
 * Builds a UsdaSearchResponse — byte-identical to what the USDA API returned.
 * @param {string} q
 * @param {number} pageSize
 * @returns {Promise<{foods: Array}>}
 */
export async function searchUsdaResponse(q, pageSize = 25) {
  const candidates = await searchFoods(q, pageSize);
  if (candidates.length === 0) return { foods: [], totalHits: 0 };

  // Pull nutrients for all found fdc_ids in a single query.
  const ids = candidates.map((c) => c.fdcId);
  const { rows: nutrientRows } = await query(
    `SELECT fdc_id, nutrient_id, value FROM food_nutrients WHERE fdc_id = ANY($1)`,
    [ids],
  );

  const nutrientsByFdc = new Map();
  for (const nr of nutrientRows) {
    if (!nutrientsByFdc.has(nr.fdc_id)) nutrientsByFdc.set(nr.fdc_id, []);
    const meta = NUTRIENT_BY_ID.get(nr.nutrient_id);
    if (!meta) continue;
    nutrientsByFdc.get(nr.fdc_id).push({
      nutrientId: nr.nutrient_id,
      nutrientName: meta.name,
      nutrientNumber: meta.number,
      unitName: meta.unit,
      value: nr.value,
    });
  }

  const foods = candidates.map((c) => ({
    fdcId: c.fdcId,
    description: c.description,
    dataType: c.dataType,
    foodNutrients: nutrientsByFdc.get(c.fdcId) ?? [],
  }));

  return { foods, totalHits: foods.length };
}
