// Локальный поиск по USDA-копии в Postgres. Заменяет сетевой вызов
// GET /fdc/v1/foods/search и собирает БАЙТ-ИДЕНТИЧНЫЙ UsdaSearchResponse.
//
// Задача ранжирования: нужный продукт должен попадать в топ (клиент/пайплайн
// затем выбирает из топ-25 через AI). USDA описывает еду как
// "Главный-ингредиент, модификатор, модификатор" — главное слово идёт первым.
//
// См. ARCHITECTURE.md (self-host USDA), db/nutrients.js (метаданные нутриентов).

import { query } from '../db/pool.js';
import { NUTRIENT_BY_ID } from '../db/nutrients.js';

// Стоп-слова, которые не должны сужать/искажать поиск.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'with', 'without', 'in', 'on',
]);

// Слова-состояния приготовления. Совпадение по ним — сильный сигнал (raw≠cooked
// меняет нутриенты в разы). Если запрос указывает состояние, а кандидат имеет
// ПРОТИВОПОЛОЖНОЕ — штрафуем; если совпадает — бонус.
const STATE_WORDS = new Set([
  'raw', 'cooked', 'boiled', 'roasted', 'fried', 'baked', 'grilled',
  'braised', 'steamed', 'stewed', 'dried', 'dehydrated', 'canned', 'frozen',
  'smoked', 'broiled',
]);

// Слова-признаки составных блюд/продуктов переработки. Если запрос — чистый
// ингредиент (нет этих слов), а кандидат их содержит — лёгкий штраф, чтобы
// базовая форма ("Egg, whole") обгоняла блюда ("Egg burrito", "Bread, egg").
const DISH_WORDS = new Set([
  'salad', 'sandwich', 'burrito', 'soup', 'cake', 'pie', 'bread', 'roll',
  'bagel', 'bagels', 'muffin', 'cookie', 'cookies', 'nuggets', 'nugget', 'creamed',
  'deviled', 'substitute', 'eggnog', 'strudel', 'juice', 'chips', 'split',
  'pizza', 'taco', 'wrap', 'casserole', 'dip', 'sauce', 'spread', 'bar',
  'snacks', 'snack', 'cereal', 'flavored', 'lunchmeat', 'oil', 'glazed',
  'dry', 'mix',
]);
// SR Legacy — самый полный референс базовых продуктов; Foundation — точные новые;
// FNDDS — блюда/составные. Порядок влияет только на тай-брейк.
const DATA_TYPE_WEIGHT = {
  sr_legacy_food: 1.0,
  foundation_food: 0.98,
  survey_fndds_food: 0.96,
};

// Синонимы для частых расхождений «бытовое слово ↔ USDA-термин».
const SYNONYMS = new Map([
  ['oatmeal', 'oats'],
  ['aubergine', 'eggplant'],
  ['courgette', 'zucchini'],
  ['prawns', 'shrimp'],
  ['prawn', 'shrimp'],
]);

// Слова-«варианты», понижающие базовую релевантность, если их нет в запросе
// (light/fat-free/reduced — не базовая форма продукта).
const VARIANT_WORDS = new Set([
  'light', 'lite', 'lowfat', 'nonfat', 'fat-free', 'reduced', 'diet',
  'unsweetened', 'sweetened', 'imitation', 'free', 'bran', 'raab',
]);

// Нормализация строки: lower, убрать пунктуацию → массив слов + синонимы.
function tokenize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SYNONYMS.get(w) ?? w);
}

// Примитивный стемминг для сопоставления ед./мн. числа и -ed/-ing форм.
// carrot↔carrots, tomato↔tomatoes, boil↔boiled. Не лингвистически точный —
// достаточно, чтобы совпадали основы.
function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s')) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  return s;
}

// Значимые токены запроса (без стоп-слов).
function significantTokens(tokens) {
  return tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

// Уровень совпадения двух слов: 2 = точное/стем, 1 = префикс, 0 = нет.
// Точное (egg==egg, carrot~carrots) сильнее префикса (egg~eggnog).
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

// Скоринг одного кандидата против токенов запроса.
// Возвращает число (больше = лучше).
function scoreCandidate(descTokens, queryTokens, dataType, trigramSim) {
  if (queryTokens.length === 0) return 0;

  let exactHits = 0; // точное/стем-совпадение целым словом
  let prefixHits = 0; // префиксное (egg~eggnog) — слабее
  let substringHits = 0;
  let firstMatchIdx = -1;
  let firstMatchLevel = 0;

  // Токены-ингредиенты (не слова-состояния): именно они определяют, тот ли это продукт.
  // Состояние (baked/cooked) — отдельный сигнал ниже. Это чинит «tuna baked»: кандидат
  // без совпадения по ингредиенту (напр. «Banana baked») получает нулевой ingredientRatio
  // и проигрывает «Fish, tuna, cooked» (тот же ингредиент, другое состояние).
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
        if (lvl === 2) break; // точное — лучшее, дальше не ищем
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

  // Доля совпавших ИНГРЕДИЕНТОВ (главный сигнал идентичности продукта).
  // Если ингредиентов в запросе нет (только состояние) — падаем на все токены.
  const ingredientRatio = ingredientTokens.length > 0
    ? ingredientHits / ingredientTokens.length
    : (exactHits + prefixHits * 0.6 + substringHits * 0.4) / Math.max(queryTokens.length, 1);
  const matchRatio = ingredientRatio;

  // Кандидат без единого совпадения по ингредиенту — почти наверняка не тот продукт.
  // Обнуляем, чтобы «Banana baked» не всплывал на «tuna baked».
  if (ingredientTokens.length > 0 && ingredientHits === 0) return 0;

  // Бонус за раннее совпадение главного слова. Усиливаем, если совпадение ТОЧНОЕ
  // (иначе "Eggnog" на позиции 0 не должен обгонять "Egg, whole" за счёт позиции).
  const posLevelMul = firstMatchLevel === 2 ? 1.0 : 0.4;
  let posBonus = 0;
  if (firstMatchIdx === 0) posBonus = 0.35;
  else if (firstMatchIdx === 1) posBonus = 0.28;
  else if (firstMatchIdx === 2) posBonus = 0.12;
  else if (firstMatchIdx > 2) posBonus = 0.04;
  posBonus *= posLevelMul;

  // Короткое описание, где почти все слова из запроса, релевантнее длинного.
  // НО не штрафуем длинные каноничные записи, если все токены запроса найдены.
  const coverage = (exactHits + prefixHits) / Math.max(descTokens.length, 1);

  // Бонус за полное покрытие запроса (все значимые токены найдены целыми словами).
  const allTokensHit = exactHits + prefixHits >= queryTokens.length;
  const fullMatchBonus = allTokensHit ? 0.4 : 0;

  // Сигнал состояния приготовления: raw/cooked/boiled...
  const descSet = new Set(descTokens);
  let stateSignal = 0;
  for (const qt of queryTokens) {
    if (STATE_WORDS.has(qt)) {
      if (descSet.has(qt)) {
        stateSignal += 0.3; // запрошенное состояние присутствует
      } else {
        // запрошено состояние, но у кандидата есть ДРУГОЕ состояние → штраф
        const hasOtherState = descTokens.some(
          (dt) => STATE_WORDS.has(dt) && dt !== qt,
        );
        if (hasOtherState) stateSignal -= 0.25;
      }
    }
  }

  const dtWeight = DATA_TYPE_WEIGHT[dataType] ?? 0.9;

  // Штраф за слова-блюда, если запрос — чистый ингредиент (без dish-слов).
  const queryIsPlain = !queryTokens.some((t) => DISH_WORDS.has(t));
  let dishPenalty = 0;
  if (queryIsPlain) {
    for (const dt of descTokens) {
      if (DISH_WORDS.has(dt)) dishPenalty -= 0.18;
    }
  }

  // Штраф за variant-слова (light/reduced/nonfat), если их нет в запросе —
  // базовая форма продукта должна выигрывать у диетических вариантов.
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
 * Поиск продуктов в локальной USDA-базе.
 * @param {string} q — поисковый запрос (английский, USDA-стиль).
 * @param {number} pageSize — макс. кандидатов (по умолчанию 25, как в клиенте).
 * @returns {Promise<Array<{fdcId,description,dataType,score}>>} ранжированные кандидаты.
 */
export async function searchFoods(q, pageSize = 25) {
  const allTokens = tokenize(q);
  const queryTokens = significantTokens(allTokens);

  if (queryTokens.length === 0) return [];

  // SQL-предфильтр: описания, содержащие хотя бы одну ОСНОВУ токена (стем, OR),
  // + порог trigram-similarity как страховка от опечаток/словоформ.
  // LIKE по стему (carrot → '%carrot%' поймает 'carrots'). Точный скоринг — в JS.
  // Тянем расширенный пул (до 400), чтобы ранжирование в JS выбрало лучшее.
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
 * Собирает UsdaSearchResponse — байт-идентичный тому, что отдавал USDA API.
 * @param {string} q
 * @param {number} pageSize
 * @returns {Promise<{foods: Array}>}
 */
export async function searchUsdaResponse(q, pageSize = 25) {
  const candidates = await searchFoods(q, pageSize);
  if (candidates.length === 0) return { foods: [], totalHits: 0 };

  // Тянем нутриенты для всех найденных fdc_id одним запросом.
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
