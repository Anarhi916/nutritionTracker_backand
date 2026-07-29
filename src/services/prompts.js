// Все AI-промпты и хелперы, портированные ДОСЛОВНО из iOS NutritionRepository.swift
// (источник истины). НЕ переписывать тексты промптов — они определяют качество AI.
// См. ARCHITECTURE.md. Хелперы (extractJSON, nutrientDataFromMap, buildNutrientsFromUsda,
// коррекции) — точная копия логики Swift.

// ── Порядок 34 полей нутриентов (snake_case ключи AI ↔ поля NutrientData) ──
export const NUTRIENT_KEYS = [
  'calories', 'protein', 'fat', 'saturated_fat', 'monounsaturated_fat',
  'polyunsaturated_fat', 'cholesterol', 'carbs', 'fiber',
  'vitamin_a', 'vitamin_b1', 'vitamin_b2', 'vitamin_b3', 'vitamin_b5',
  'vitamin_b6', 'vitamin_b7', 'vitamin_b9', 'vitamin_b12', 'vitamin_c',
  'vitamin_d', 'vitamin_e', 'vitamin_k', 'calcium', 'iron', 'magnesium',
  'phosphorus', 'potassium', 'sodium', 'zinc', 'copper', 'manganese',
  'selenium', 'iodine',
];

// Микронутриенты (24 поля) — то, что дозаполняет micro-fill.
export const MICRO_KEYS = [
  'vitamin_a', 'vitamin_b1', 'vitamin_b2', 'vitamin_b3', 'vitamin_b5',
  'vitamin_b6', 'vitamin_b7', 'vitamin_b9', 'vitamin_b12', 'vitamin_c',
  'vitamin_d', 'vitamin_e', 'vitamin_k', 'calcium', 'iron', 'magnesium',
  'phosphorus', 'potassium', 'sodium', 'zinc', 'copper', 'manganese',
  'selenium', 'iodine',
];

// Единицы для enrichMicros (single) — дословно из Swift (vitamin_a с 'mcg RAE').
const MICRO_UNITS = {
  vitamin_a: 'mcg RAE', vitamin_b1: 'mg', vitamin_b2: 'mg', vitamin_b3: 'mg',
  vitamin_b5: 'mg', vitamin_b6: 'mg', vitamin_b7: 'mcg', vitamin_b9: 'mcg',
  vitamin_b12: 'mcg', vitamin_c: 'mg', vitamin_d: 'mcg', vitamin_e: 'mg',
  vitamin_k: 'mcg', calcium: 'mg', iron: 'mg', magnesium: 'mg',
  phosphorus: 'mg', potassium: 'mg', sodium: 'mg', zinc: 'mg',
  copper: 'mg', manganese: 'mg', selenium: 'mcg', iodine: 'mcg',
};

// ── extractJSON: чистит markdown-фенсы, находит первый {/[ и парный закрывающий ──
export function extractJSON(text) {
  let cleaned = String(text).replaceAll('```json', '').replaceAll('```', '').trim();
  const firstIdx = [...cleaned].findIndex((c) => c === '{' || c === '[');
  if (firstIdx >= 0) cleaned = cleaned.slice(firstIdx);
  if (cleaned[0] === '[') {
    const last = cleaned.lastIndexOf(']');
    if (last >= 0) cleaned = cleaned.slice(0, last + 1);
  } else if (cleaned[0] === '{') {
    const last = cleaned.lastIndexOf('}');
    if (last >= 0) cleaned = cleaned.slice(0, last + 1);
  }
  return cleaned;
}

// Парсит JSON-объект из ответа AI (после extractJSON).
export function parseJSONMap(text) {
  return JSON.parse(extractJSON(text));
}

// Парсит JSON-массив объектов (batch/micro).
export function parseJSONArray(text) {
  const parsed = JSON.parse(extractJSON(text));
  if (Array.isArray(parsed)) return parsed;
  // иногда AI оборачивает в объект — берём первый вложенный массив
  for (const v of Object.values(parsed)) if (Array.isArray(v)) return v;
  return [];
}

// Число из map по ключу (NSNumber-семантика: число, строка-число, иначе 0).
function num(map, key) {
  const v = map[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ── nutrientDataFromMap: JSON snake_case → объект нутриентов (34 поля, все на 100г) ──
export function nutrientDataFromMap(map) {
  const n = {};
  for (const key of NUTRIENT_KEYS) n[key] = num(map, key);
  return n;
}

// Пустой набор нутриентов (все нули).
export function emptyNutrients() {
  const n = {};
  for (const key of NUTRIENT_KEYS) n[key] = 0;
  return n;
}

// ── fillMissingMicros: заполняет ТОЛЬКО нулевые микро-поля из map (iodine < 0.01) ──
export function fillMissingMicros(nutrients, map) {
  const n = { ...nutrients };
  for (const key of MICRO_KEYS) {
    if (key === 'iodine') {
      if ((n.iodine ?? 0) < 0.01) n.iodine = num(map, 'iodine');
    } else if ((n[key] ?? 0) === 0) {
      n[key] = num(map, key);
    }
  }
  return n;
}

// ══════════════════════ ПРОМПТЫ (дословный порт) ══════════════════════

// buildIdentifyPrompt — uiLang = English name языка UI (напр. "German").
export function buildIdentifyPrompt(description, uiLang) {
  return `Определи ВСЕ продукты и их вес из описания. Описание может быть на любом языке.
Если указано количество штук — рассчитай общий вес. Если вес не указан — оцени типичную порцию.

ВАЖНО:
- food_name — название продукта на языке "${uiLang}" (this is the app's UI language; translate the product name into ${uiLang} so it displays consistently)
- food_name_en — ТОЧНЫЙ перевод на английский для поиска в USDA базе данных

Примеры правильного перевода:
- "куриная отбивная" / "куряча відбивна" → "chicken breast cutlet"
- "гречневая каша" / "гречана каша" → "buckwheat porridge"
- "ячневая каша вареная" → "barley porridge cooked"
- "овсяная каша" / "вівсяна каша" → "oatmeal cooked"
- "творог нежирный" → "low-fat cottage cheese"
- "борщ" → "borscht"
- "вареники с картошкой" → "potato pierogi"
- "пельмени" → "pelmeni meat dumplings"
- "сырники" / "сирники" → "cottage cheese pancakes"
- "голубці" / "голубцы" → "stuffed cabbage rolls"
- "деруни" / "драники" → "potato pancakes"
- "лосось слабосоленный" → "salmon salted"
- "кава" / "кофе" → "coffee brewed"
- "капучіно" / "капучино" → "coffee cappuccino"

КРИТИЧЕСКИ ВАЖНО для мяса/птицы с указанием способа приготовления:
"тушеная/тушена" для МЯСА = "braised" (НЕ "stew" — stew это блюдо с овощами и подливкой!)
"жареная/смажена" для МЯСА = "fried" или "pan-fried"
"запечённая/запечена" для МЯСА = "baked" или "roasted"
"варёная/варена/отварная" для МЯСА = "cooked" или "boiled"

Примеры:
- "говядина тушеная" / "яловичина тушкована" → "beef braised" (НЕ "beef stew"!)
- "свинина тушеная" / "свинина тушкована" → "pork braised"
- "курица тушеная" / "курка тушкована" → "chicken braised"
- "говядина жареная" / "яловичина смажена" → "beef pan-fried"
- "свинина запечённая" / "свинина запечена" → "pork roasted"
- "говядина варёная" / "яловичина варена" → "beef cooked"
- "телятина тушеная" → "veal braised"
- "баранина тушеная" / "баранина тушкована" → "lamb braised"
- "кролик тушеный" / "кролик тушкований" → "rabbit braised"

ВАЖНО: слова "вареная"/"варена"/"варенная"/"варёная"/"отварная" ВСЕ означают "cooked" — всегда добавляй "cooked" в перевод!

ВАЖНО для свежих овощей/фруктов/ягод/зелени:
Если продукт — свежий овощ, фрукт, ягода, зелень или листовой салат,
и в названии НЕ указан способ приготовления (вареный/жареный/тушёный/печёный/квашеный/маринованный/сушёный и т.п.),
обязательно добавь "raw" в food_name_en. USDA по умолчанию выдаёт салаты и обработанные варианты вместо свежего продукта.

Примеры:
- "капуста" → "cabbage raw"
- "морковь" / "морква" → "carrot raw"
- "яблоко" / "яблуко" → "apple raw"
- "помидор" / "помідор" → "tomato raw"
- "огурец" / "огірок" → "cucumber raw"
- "лук" / "цибуля" → "onion raw"
- "шпинат" → "spinach raw"
- "клубника" / "полуниця" → "strawberry raw"
- "банан" → "banana raw"
- "брокколи" → "broccoli raw"
- "перец болгарский" / "перець солодкий" → "bell pepper raw"
- "свекла" / "буряк" / "свёкла" → "beet raw"
- "репа" / "ріпа" → "turnip raw"
- "редька" / "редька чёрная" → "radish raw"
- "тыква" / "гарбуз" → "pumpkin raw"
- "кабачок" / "цукіні" → "zucchini raw"
- "баклажан" → "eggplant raw"
- "сельдерей" / "селера" → "celery raw"
- "петрушка" / "петрушка свіжа" → "parsley raw"
- "укроп" / "кріп" → "dill raw"
- "виноград" / "виноград" → "grapes raw"
- "черешня" / "черешні" → "sweet cherry raw"
- "вишня" / "вишні" → "sour cherry raw"
- "черника" / "чорниця" → "blueberry raw"
- "голубика" / "лохина" → "blueberry raw"
- "смородина чёрная" / "чорна смородина" → "blackcurrant raw"
- "смородина красная" / "червона смородина" → "redcurrant raw"
- "кукуруза" / "кукурудза" → "corn raw"
- "горох свежий" / "горох" → "peas raw"
- "фасоль стручковая" / "зелена квасоля" → "green beans raw"
- "цветная капуста" / "цвітна капуста" → "cauliflower raw"
- "авокадо" → "avocado raw"
- "ананас" → "pineapple raw"
- "манго" → "mango raw"
- "киви" → "kiwi raw"

ВАЖНО для USDA — используй АМЕРИКАНСКИЙ английский, не британский:
- "beet", НЕ "beetroot" (beetroot = только чипсы в USDA)
- "eggplant", НЕ "aubergine"
- "zucchini", НЕ "courgette"
- "cilantro", НЕ "coriander" (для зелени)
- "bell pepper", НЕ "capsicum"

НЕ добавляй "raw" для:
- мяса/рыбы/птицы/яиц (без указания способа — подразумевается приготовленное)
- круп, макарон, бобовых, хлеба
- молочных продуктов, сыров, орехов, семян, масел
- готовых блюд, консервов, продуктов прошедших обработку
- если в названии уже есть способ приготовления или "сырой"/"свіжий"/"raw"/"fresh"

ВАЖНО для составных блюд (салаты, супы):
- НЕ перечисляй все ингредиенты в food_name_en — используй КОРОТКОЕ узнаваемое название
- Если блюдо "без заправки" / "без майонеза" — НЕ включай "without dressing" в food_name_en

Описание: ${description}

Верни ТОЛЬКО JSON массив (даже если продукт один):
[{"food_name": "<product name in the app UI language>", "food_name_en": "<EXACT English translation for USDA search>", "weight_grams": <число>}]`;
}

// generateUsdaSearchQueries — вход: queryRu (ориг. язык) + queryEn (англ.).
export function buildUsdaQueriesPrompt(queryRu, queryEn) {
  return `You are a USDA Food Data Central (FDC) database search expert. Generate 2-3 English search queries that will find the correct USDA FDC entry for the given food.

User query (original language): "${queryRu}"
User query (English): "${queryEn}"

USDA FDC names food as INGREDIENT + PREPARATION STATE — NOT as dish names. This is critical:

RULE 1 — MEAT / POULTRY with a cooking method → use the method as an adjective, NEVER a dish name:
  Correct: "beef braised", "pork roasted", "chicken fried", "lamb braised", "turkey baked"
  WRONG: "beef stew", "pork ragout", "chicken casserole", "lamb curry", "beef stroganoff"
  → "beef stew" is a composite DISH (with vegetables and sauce). "beef braised" is the INGREDIENT.
  → Any word like stew / ragout / casserole / curry / stroganoff / goulash = composite dish → DO NOT use.
  Examples:
  - "говядина тушёная" / "beef braised" → ["beef braised", "beef chuck braised"]
  - "свинина тушёная" / "pork braised" → ["pork braised", "pork shoulder braised"]
  - "курица тушёная" / "chicken braised" → ["chicken braised", "chicken thigh braised"]
  - "говядина жареная" / "beef fried" → ["beef pan-fried", "beef fried"]
  - "свинина запечённая" / "pork roasted" → ["pork roasted", "pork loin roasted"]
  - "баранина тушёная" / "lamb braised" → ["lamb braised", "lamb shoulder braised"]

RULE 2 — FISH / SEAFOOD with a cooking method → same rule, never dish names:
  - "судак тушёный" / "pike-perch braised" → ["pike-perch braised", "walleye braised", "walleye cooked"]
  - "треска запечённая" / "cod baked" → ["cod baked", "cod roasted"]

RULE 3 — GRAINS / PORRIDGE → use "cooked" or the grain name:
  - "гречка варёная" / "buckwheat cooked" → ["buckwheat groats cooked", "buckwheat cooked"]
  - "пшённая каша" / "millet porridge" → ["millet cooked", "millet porridge"]

RULE 4 — REGIONAL / LOCALISED foods → use the closest USDA synonym:
  - "черемша" / "wild garlic" → ["ramps raw", "wild leek raw"] (USDA uses "ramps", NOT "wild garlic")
  - "творог" / "cottage cheese" → ["cottage cheese", "cottage cheese lowfat"]
  - "ряженка" / "cultured milk" → ["kefir", "cultured milk fermented"]

RULE 5 — RAW produce → add "raw":
  - "помидор" / "tomato" → ["tomato raw"]
  - "яблоко" / "apple" → ["apple raw"]

RULE 6 — Use American English: beet (not beetroot), eggplant (not aubergine), zucchini (not courgette), cilantro (not coriander leaf).

RULE 7 — Return 2-3 queries, most specific first. If the English query already looks like a correct USDA query (e.g. "salmon salted", "oatmeal cooked"), include it as-is and add one variation.

Return ONLY a JSON array of English strings:
["query1", "query2"]`;
}

// askAiToPickUsdaCandidate — list = пронумерованные кандидаты (per 100g).
export function buildPickPrompt(queryRu, queryEn, list) {
  return `You are a nutrition expert selecting the single best USDA Food Data Central entry that matches a user's food query.

User query (original language): "${queryRu}"
User query (English): "${queryEn}"

USDA candidates (values are per 100g):
${list}

Selection rules — in order of importance:

1. **BIOLOGICAL IDENTITY is non-negotiable.** The candidate MUST be the SAME species / product as the query — not a lexically similar but biologically different food. If none of the candidates is the same product, return fdc_id = null.
   Common traps to REJECT:
   - "черемша" / "wild garlic" / "ramps" / "wild leek" (Allium ursinum / Allium tricoccum) is NOT the same as "garlic" (Allium sativum) — garlic bulbs have ~33g carbs, wild garlic leaves have ~3-6g. Never accept "Garlic, raw" for a "wild garlic" / "ramps" / "черемша" query.
   - "cashew" is NOT "chestnut"; "chestnut" is NOT "water chestnut".
   - "cilantro" / "coriander leaf" is NOT "coriander seed"; "parsley" is NOT "cilantro".
   - "sweet potato" / "yam" is NOT "potato".
   - "sour cherry" / "вишня" is NOT "sweet cherry" / "черешня".
   - "buckwheat" is NOT "wheat"; "millet" is NOT "corn".
   - "quinoa" is NOT "couscous"; "spelt" is NOT "wheat".
   - "kohlrabi" is NOT "cabbage"; "bok choy" is NOT "cabbage".
   - "veal" is NOT "beef"; "mutton" is NOT "lamb".
   - "salmon" is NOT "trout"; "cod" is NOT "haddock" (different species — check the description carefully).
   - Frozen / canned / dried / juice / pie / jam / chips / cereal / candy / powder / ice cream forms are NOT the raw whole product.

2. **Macronutrient sanity check.** For the query's food family (leafy green, root vegetable, fruit, meat, grain, dairy...), the candidate's macros must be plausible. A "leafy green vegetable" query with >20g carbs per 100g is almost certainly the wrong product (leaves rarely exceed 5-8g carbs). A "raw fruit" query with 0g fiber and >30g carbs is likely juice or dried fruit.

3. **Preparation state must match:**
   - For raw fruits / vegetables / berries with no cooking method mentioned — pick "raw" / whole product.
   - For cooked / boiled / porridge — pick an entry with matching preparation state ("cooked", NOT "from raw" which means dry-weight equivalent).
   - Frozen / canned / dried / juice / pie / jam / chips / cereal / candy / powder / ice cream are different products — do NOT accept unless the query explicitly asked for that form.

4. **Data-type preference:** Prefer "Survey (FNDDS)", "SR Legacy", "Foundation" over "Branded" for generic ingredients.

5. **Implausible Branded macros filter:** Reject Branded entries where protein > 40g (unless protein powder / whey / jerky / parmesan), carbs > 75g (unless sugar / jam / flour / cereal / dried), fat > 70g (unless oil / butter / ghee / lard / mayonnaise).

6. **Atwater check:** Reject entries where 4·protein + 9·fat + 4·carbs > 1.3 × calories.

7. **Poultry:** For chicken / turkey breast or thigh, prefer "skinless" / "meat only" unless the query mentions skin or coating.

8. **Generic over variety:** Prefer generic entries over variety-specific ones when the query has no variety qualifier ("tomatoes, raw" over "tomatoes, green, raw").

9. **No hallucination:** Only return an fdcId from the numbered list above. If nothing is a good match, return null — DO NOT force a pick.

Return ONLY a JSON object:
{"fdc_id": <chosen id, or null if none of the candidates match well>, "reason": "<one short sentence explaining the pick or why nothing fit>"}`;
}

// verifyUsdaPick — адверсариальная проверка одного выбранного кандидата.
export function buildVerifyPrompt(queryRu, queryEn, pick) {
  const fmt = (v, d = 1) => Number(v ?? 0).toFixed(d);
  return `You are a nutrition-safety reviewer. Someone selected a USDA entry as the match for a user's food query. Your job is to REJECT it if the entry is NOT the same biological product / species / dish, even if the names are lexically similar.

User query (original language): "${queryRu}"
User query (English): "${queryEn}"

Selected USDA entry:
  description: "${pick.description}"
  dataType:    "${pick.dataType}"
  per 100g:    cal=${fmt(pick.calories, 0)}, P=${fmt(pick.protein)}, F=${fmt(pick.fat)}, C=${fmt(pick.carbs)}

Answer TWO questions:
1. is_same_product: is this USDA entry the SAME biological product / species / dish as the user asked for? Different species (garlic vs wild garlic, cashew vs chestnut, cilantro vs parsley, sour vs sweet cherry, sweet potato vs potato, veal vs beef, salmon vs trout, buckwheat vs wheat, etc.) → false. Different form (juice / jam / pie / chips / dried / candied / powder / ice cream when the user asked for the whole raw product) → false.
   IMPORTANT: a DIFFERENT COOKING METHOD is NOT a different product. "baked" vs "cooked" vs "roasted" vs "grilled" vs "broiled" for the same ingredient (e.g. "baked tuna" query vs "Fish, tuna, cooked" entry) → is_same_product = TRUE. USDA often has only a generic "cooked" entry; accept it for any dry-heat cooking method. Only reject on a genuinely different species/product/form.
2. macros_plausible: are the per-100g macros plausible for the QUERIED product's food family? A leafy green with >15g carbs is suspicious. A raw fruit with 0g fiber and >30g carbs is likely juice or dried. Meat with 0g protein is wrong. Do NOT reject plausible macros just because the cooking method differs — cooked fish at ~180 kcal / 30g protein / 5g fat is perfectly plausible for "baked tuna".

Default to false if unsure. It's better to reject a correct pick than accept a wrong one — the caller will fall back to a different data source.

Return ONLY a JSON object:
{"is_same_product": <true|false>, "macros_plausible": <true|false>, "reason": "<one short sentence>"}`;
}

// buildBatchNutrientPrompt — foodsList: нумерованный список "N. name (per 100g)".
export function buildBatchNutrientPrompt(foodsList, count) {
  return `You are a professional nutritionist. Provide nutritional values PER 100 GRAMS for EACH food below.
Return ONLY a JSON array with one object per food, in the SAME ORDER.

IMPORTANT — liquid drinks: compote (компот), mors (морс), kissel (кисель, thin), fruit-infused water,
diluted juice, tea/coffee with sugar and similar DRINKS are mostly water. Their per-100g values are LOW:
a typical drinkable fruit compote is ~40-70 kcal and ~10-17 g carbs per 100g (it is a beverage sipped
from a glass, NOT concentrated stewed fruit in syrup). Do NOT return concentrate/jam/syrup values for a drink.

Foods:
${foodsList}

Return format (array of ${count} objects):
[{"calories": <kcal>, "protein": <g>, "fat": <g>, "saturated_fat": <g>, "monounsaturated_fat": <g>, "polyunsaturated_fat": <g>, "cholesterol": <mg>, "carbs": <g>, "fiber": <g>, "vitamin_a": <mcg>, "vitamin_b1": <mg>, "vitamin_b2": <mg>, "vitamin_b3": <mg>, "vitamin_b5": <mg>, "vitamin_b6": <mg>, "vitamin_b7": <mcg>, "vitamin_b9": <mcg>, "vitamin_b12": <mcg>, "vitamin_c": <mg>, "vitamin_d": <mcg>, "vitamin_e": <mg>, "vitamin_k": <mcg>, "calcium": <mg>, "iron": <mg>, "magnesium": <mg>, "phosphorus": <mg>, "potassium": <mg>, "sodium": <mg>, "zinc": <mg>, "copper": <mg>, "manganese": <mg>, "selenium": <mcg>, "iodine": <mcg>}]`;
}

// buildMicroFillPrompt — foodsList: нумерованный список "N. name" (без суффикса).
export function buildMicroFillPrompt(foodsList, count) {
  return `For each food below, provide ALL micronutrients PER 100 GRAMS using USDA reference values.
Return ONLY a JSON array with one object per food, in the SAME ORDER.

IMPORTANT: iodine is REQUIRED. Typical: seafood 30-160 mcg, dairy 20-50 mcg, egg 24 mcg, buckwheat 3.3 mcg.

Foods:
${foodsList}

Return format (array of ${count} objects):
[{"vitamin_a": <mcg>, "vitamin_b1": <mg>, "vitamin_b2": <mg>, "vitamin_b3": <mg>, "vitamin_b5": <mg>, "vitamin_b6": <mg>, "vitamin_b7": <mcg>, "vitamin_b9": <mcg>, "vitamin_b12": <mcg>, "vitamin_c": <mg>, "vitamin_d": <mcg>, "vitamin_e": <mg>, "vitamin_k": <mcg>, "calcium": <mg>, "iron": <mg>, "magnesium": <mg>, "phosphorus": <mg>, "potassium": <mg>, "sodium": <mg>, "zinc": <mg>, "copper": <mg>, "manganese": <mg>, "selenium": <mcg>, "iodine": <mcg>}]`;
}

// enrichMicros (single) — строит список недостающих (== 0, iodine < 0.01) + промпт.
// Возвращает {prompt, missing}. Если missing пуст — prompt === null.
export function buildEnrichMicrosPrompt(nutrients, foodNameEn) {
  const missing = [];
  for (const key of MICRO_KEYS) {
    const zero = key === 'iodine' ? (nutrients.iodine ?? 0) < 0.01 : (nutrients[key] ?? 0) === 0;
    if (zero) missing.push(`${key} (${MICRO_UNITS[key]})`);
  }
  if (missing.length === 0) return { prompt: null, missing };
  const prompt = `For "${foodNameEn}" per 100g, provide ONLY these nutrients using USDA reference values.
${missing.join(', ')}
Return ONLY JSON, e.g.: {"vitamin_a": 45, "calcium": 11}`;
  return { prompt, missing };
}

// enrichFatDetails — AI-промпт разбивки жиров (fat > 0, mono==0 && poly==0).
export function buildFatDetailsPrompt(foodNameEn, totalFat) {
  return `For the food product "${foodNameEn}" with total fat ${totalFat}g per 100g, estimate the fat breakdown.
Return ONLY a JSON object:
{"saturated_fat": <grams>, "monounsaturated_fat": <grams>, "polyunsaturated_fat": <grams>, "cholesterol": <mg>}
Rules:
- CRITICAL: saturated_fat + monounsaturated_fat + polyunsaturated_fat MUST be <= ${totalFat}g (total fat)
- Each value must be >= 0 and individually less than total fat (${totalFat}g)
- cholesterol is in mg (milligrams), typical range 0-300mg per 100g
- Use established nutritional data for this food`;
}

// analyzeSingleDish — целое блюдо, food_name_en + 34 поля.
export function buildSingleDishPrompt(dishName) {
  return `You are a professional nutritionist. Provide nutritional values PER 100 GRAMS for this COMPLETE DISH (do NOT split into ingredients):
"${dishName}"

IMPORTANT — if this is a liquid drink (compote/компот, mors/морс, thin kissel/кисель, fruit-infused water,
diluted juice, tea/coffee): it is mostly water, so per-100g values are LOW (a drinkable fruit compote is
~40-70 kcal, ~10-17 g carbs per 100g — a beverage, NOT concentrated stewed fruit in syrup).

Return ONLY a JSON object with these fields:
{"food_name_en": "<English translation>", "calories": <kcal>, "protein": <g>, "fat": <g>, "saturated_fat": <g>, "monounsaturated_fat": <g>, "polyunsaturated_fat": <g>, "cholesterol": <mg>, "carbs": <g>, "fiber": <g>, "vitamin_a": <mcg>, "vitamin_b1": <mg>, "vitamin_b2": <mg>, "vitamin_b3": <mg>, "vitamin_b5": <mg>, "vitamin_b6": <mg>, "vitamin_b7": <mcg>, "vitamin_b9": <mcg>, "vitamin_b12": <mcg>, "vitamin_c": <mg>, "vitamin_d": <mcg>, "vitamin_e": <mg>, "vitamin_k": <mcg>, "calcium": <mg>, "iron": <mg>, "magnesium": <mg>, "phosphorus": <mg>, "potassium": <mg>, "sodium": <mg>, "zinc": <mg>, "copper": <mg>, "manganese": <mg>, "selenium": <mcg>, "iodine": <mcg>}`;
}

// correctDairyMacros (ГОСТ) — percent из имени.
export function buildDairyPrompt(foodNameRu, percent) {
  return `You are a professional nutritionist. The user entered a dairy product following the Russian/Ukrainian GOST standard, where the percentage in the name is grams of fat per 100g of the final product (NOT % of milkfat in the source milk, NOT USDA cottage cheese variants).

Product: "${foodNameRu}"
Fat percentage from name: ${percent}% (= ${percent} g of fat per 100g)

Return ONLY a JSON object with macronutrients PER 100 GRAMS of this product, according to GOST/DSTU reference data:
{"protein": <g>, "fat": <g>, "carbs": <g>, "calories": <kcal>}

Examples for calibration (per 100g):
- "творог 0%": {"protein": 18.0, "fat": 0.0, "carbs": 1.8, "calories": 71}
- "творог 5%": {"protein": 17.2, "fat": 5.0, "carbs": 1.8, "calories": 121}
- "творог 9%": {"protein": 16.7, "fat": 9.0, "carbs": 2.0, "calories": 156}
- "молоко 2.5%": {"protein": 2.9, "fat": 2.5, "carbs": 4.7, "calories": 52}
- "сметана 20%": {"protein": 2.5, "fat": 20.0, "carbs": 3.2, "calories": 206}
- "кефир 1%": {"protein": 2.8, "fat": 1.0, "carbs": 4.0, "calories": 37}
- "йогурт 3.2%": {"protein": 5.0, "fat": 3.2, "carbs": 8.5, "calories": 82}

The fat value MUST equal ${percent}. Calories MUST satisfy: protein*4 + fat*9 + carbs*4 ≈ calories.`;
}

// identifyAndAnalyzeFoodFromPhoto — uiLang = English name языка UI.
export function buildPhotoPrompt(uiLang) {
  return `You are a professional nutritionist. Look at this food photo and:
1. Identify the dish/food name IN ${uiLang.toUpperCase()} (detailed, including ingredients)
2. Estimate total portion weight in grams
3. Provide nutritional values PER 100 GRAMS for this complete dish

Return ONLY a JSON object:
{"food_name": "<dish name in ${uiLang}>", "food_name_en": "<English translation>", "weight_grams": <number>, "calories": <kcal>, "protein": <g>, "fat": <g>, "saturated_fat": <g>, "monounsaturated_fat": <g>, "polyunsaturated_fat": <g>, "cholesterol": <mg>, "carbs": <g>, "fiber": <g>, "vitamin_a": <mcg>, "vitamin_b1": <mg>, "vitamin_b2": <mg>, "vitamin_b3": <mg>, "vitamin_b5": <mg>, "vitamin_b6": <mg>, "vitamin_b7": <mcg>, "vitamin_b9": <mcg>, "vitamin_b12": <mcg>, "vitamin_c": <mg>, "vitamin_d": <mcg>, "vitamin_e": <mg>, "vitamin_k": <mcg>, "calcium": <mg>, "iron": <mg>, "magnesium": <mg>, "phosphorus": <mg>, "potassium": <mg>, "sodium": <mg>, "zinc": <mg>, "copper": <mg>, "manganese": <mg>, "selenium": <mcg>, "iodine": <mcg>}`;
}

// calculateNorms — genderForPrompt/age/weight(kg)/height(cm)/goals.
export function buildNormsPrompt(genderForPrompt, age, weight, height, goals) {
  return `You are a professional nutrition expert. Based on the following user data, calculate the recommended DAILY nutritional intake to achieve their goals.

User data:
- Gender: ${genderForPrompt}
- Age: ${age} years
- Weight: ${weight} kg
- Height: ${height} cm
- Goals and activity level: ${goals}

IMPORTANT: All values MUST be in the units specified. Pay special attention:
- copper is in MG (milligrams), NOT mcg. Typical adult RDA is 0.9 mg.
- manganese is in MG. Typical adult AI is 2.3 mg.
- selenium, iodine are in MCG (micrograms).

Calculate daily norms and return ONLY a JSON object with this EXACT structure (all numbers, no text):
{"calories": <number>, "protein": <grams>, "fat": <grams>, "saturated_fat": <grams>, "monounsaturated_fat": <grams>, "polyunsaturated_fat": <grams>, "cholesterol": <mg>, "carbs": <grams>, "fiber": <grams>, "vitamin_a": <mcg>, "vitamin_b1": <mg>, "vitamin_b2": <mg>, "vitamin_b3": <mg>, "vitamin_b5": <mg>, "vitamin_b6": <mg>, "vitamin_b7": <mcg>, "vitamin_b9": <mcg>, "vitamin_b12": <mcg>, "vitamin_c": <mg>, "vitamin_d": <mcg>, "vitamin_e": <mg>, "vitamin_k": <mcg>, "calcium": <mg>, "iron": <mg>, "magnesium": <mg>, "phosphorus": <mg>, "potassium": <mg>, "sodium": <mg>, "zinc": <mg>, "copper": <mg, e.g. 0.9>, "manganese": <mg, e.g. 2.3>, "selenium": <mcg>, "iodine": <mcg>}`;
}

// sanitizeNormUnits — фикс единиц норм (медь/марганец mcg→mg, селен mg→mcg).
export function sanitizeNormUnits(n) {
  const r = { ...n };
  if (r.copper > 10) r.copper /= 1000.0;
  if (r.manganese > 50) r.manganese /= 1000.0;
  if (r.selenium > 0 && r.selenium < 1) r.selenium *= 1000.0;
  return r;
}

// извлечение % жирности из имени (0..100).
export function extractFatPercent(foodName) {
  const m = String(foodName).match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m) return null;
  const p = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(p) || p < 0 || p > 100) return null;
  return p;
}

// убирает "% жирности" из имени для поиска в USDA по общему имени.
export function stripFatPercent(foodName) {
  return String(foodName)
    .replace(/\s*\d+(?:[.,]\d+)?\s*%\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DAIRY_FAT_KEYWORDS = [
  'творог', 'творожн', 'сирок', 'сырок', 'сир знежирен', 'сир нежирн', 'сир кисломолочн',
  'молоко', 'сметана', 'кефир', 'ряженка', 'ряжанка', 'йогурт', 'сливки', 'вершки',
  'простокваша', 'ацидофилин', 'айран', 'тан', 'мацони', 'снежок', 'бифидок',
  'cottage cheese', 'quark', 'curd', 'milk', 'sour cream', 'kefir',
  'ryazhenka', 'yogurt', 'yoghurt', 'cream', 'buttermilk',
];

// true если dairy-продукт с явным % жирности (твёрдые сыры исключены).
export function isDairyWithFatPercent(foodName, englishName = '') {
  const lower = `${foodName} ${englishName}`.toLowerCase();
  const hasKeyword = DAIRY_FAT_KEYWORDS.some((k) => lower.includes(k));
  const isHardCheese =
    (lower.includes('сыр') || lower.includes('сир') ||
      (lower.includes('cheese') && !lower.includes('cottage'))) &&
    !hasKeyword;
  if (isHardCheese) return false;
  if (!hasKeyword) return false;
  return extractFatPercent(foodName) !== null || extractFatPercent(englishName) !== null;
}

// buildNutrientsFromUsda — извлекает NutrientData из USDA food + все проверки.
// Возвращает объект нутриентов ИЛИ null (если отбраковано).
// nMap: Map<nutrientId, value>. usdaNutrientById: как в db/nutrients.js (id→поле).
import { NUTRIENT_ID } from '../db/nutrients.js';

export function buildNutrientsFromUsda(food, query, negationCleaned) {
  const foodNutrients = food.foodNutrients;
  if (!Array.isArray(foodNutrients)) return null;

  const nMap = new Map();
  for (const fn of foodNutrients) {
    if (fn.nutrientId != null && fn.value != null) nMap.set(fn.nutrientId, fn.value);
  }
  const get = (id) => nMap.get(id) ?? 0;

  // Branded implausibility guard
  if (food.dataType === 'Branded') {
    const prot = get(NUTRIENT_ID.PROTEIN);
    const fat = get(NUTRIENT_ID.FAT);
    const carbs = get(NUTRIENT_ID.CARBS);
    const ql = String(query).toLowerCase();
    const highProtOk = ['protein', 'powder', 'whey', 'casein', 'isolate', 'jerky', 'parmesan'].some((s) => ql.includes(s));
    const highCarbOk = ['sugar', 'honey', 'syrup', 'candy', 'jam', 'dried', 'flour', 'cereal', 'granola'].some((s) => ql.includes(s));
    const highFatOk = ['oil', 'butter', 'lard', 'ghee', 'mayo', 'mayonnaise'].some((s) => ql.includes(s));
    if ((prot > 40 && !highProtOk) || (carbs > 75 && !highCarbOk) || (fat > 70 && !highFatOk)) {
      return null;
    }
  }

  const per100g = {
    calories: get(NUTRIENT_ID.ENERGY), protein: get(NUTRIENT_ID.PROTEIN), fat: get(NUTRIENT_ID.FAT),
    saturated_fat: get(NUTRIENT_ID.SATURATED_FAT), monounsaturated_fat: get(NUTRIENT_ID.MONOUNSATURATED_FAT),
    polyunsaturated_fat: get(NUTRIENT_ID.POLYUNSATURATED_FAT), cholesterol: get(NUTRIENT_ID.CHOLESTEROL),
    carbs: get(NUTRIENT_ID.CARBS), fiber: get(NUTRIENT_ID.FIBER),
    vitamin_a: get(NUTRIENT_ID.VITAMIN_A), vitamin_b1: get(NUTRIENT_ID.VITAMIN_B1),
    vitamin_b2: get(NUTRIENT_ID.VITAMIN_B2), vitamin_b3: get(NUTRIENT_ID.VITAMIN_B3),
    vitamin_b5: get(NUTRIENT_ID.VITAMIN_B5), vitamin_b6: get(NUTRIENT_ID.VITAMIN_B6),
    vitamin_b7: get(NUTRIENT_ID.VITAMIN_B7), vitamin_b9: get(NUTRIENT_ID.VITAMIN_B9),
    vitamin_b12: get(NUTRIENT_ID.VITAMIN_B12), vitamin_c: get(NUTRIENT_ID.VITAMIN_C),
    vitamin_d: get(NUTRIENT_ID.VITAMIN_D), vitamin_e: get(NUTRIENT_ID.VITAMIN_E),
    vitamin_k: get(NUTRIENT_ID.VITAMIN_K), calcium: get(NUTRIENT_ID.CALCIUM),
    iron: get(NUTRIENT_ID.IRON), magnesium: get(NUTRIENT_ID.MAGNESIUM),
    phosphorus: get(NUTRIENT_ID.PHOSPHORUS), potassium: get(NUTRIENT_ID.POTASSIUM),
    sodium: get(NUTRIENT_ID.SODIUM), zinc: get(NUTRIENT_ID.ZINC),
    copper: get(NUTRIENT_ID.COPPER), manganese: get(NUTRIENT_ID.MANGANESE),
    selenium: get(NUTRIENT_ID.SELENIUM), iodine: get(NUTRIENT_ID.IODINE),
  };

  // US flour-fortification correction
  const flourKeywords = [
    'pierogi', 'dumpling', 'pelmeni', 'ravioli', 'wonton',
    'bread', 'roll', 'bun', 'bagel', 'tortilla', 'pita', 'naan', 'flatbread',
    'pasta', 'noodle', 'spaghetti', 'macaroni', 'lasagna',
    'pancake', 'crepe', 'waffle', 'blini', 'blintz',
    'cake', 'cookie', 'biscuit', 'muffin', 'pie', 'pastry', 'croissant', 'doughnut',
    'flour', 'cereal', 'cornmeal', 'porridge',
  ];
  const foodDesc = `${food.description ?? ''} ${query}`.toLowerCase();
  if (flourKeywords.some((k) => foodDesc.includes(k))) {
    per100g.vitamin_b1 *= 0.17;
    per100g.vitamin_b2 *= 0.10;
    per100g.vitamin_b3 *= 0.22;
    per100g.vitamin_b9 *= 0.17;
    per100g.iron *= 0.26;
  }

  // Atwater sanity check + implausible-macro guard
  const macroCalories = per100g.protein * 4 + per100g.fat * 9 + per100g.carbs * 4;
  const nc = String(negationCleaned).toLowerCase();
  const isPureFat = ['oil', 'butter', 'lard', 'ghee', 'shortening', 'fat', 'grease'].some((s) => nc.includes(s));
  const macroPlausible = isPureFat || !(per100g.protein === 0 && per100g.carbs === 0 && per100g.fat > 0);
  const zeroCalorieFoods = ['water', 'tea', 'coffee', 'herb', 'spice', 'vinegar', 'gelatin'];
  const queryIsZeroCalorie = zeroCalorieFoods.some((s) => nc.includes(s));
  const sane =
    (per100g.calories === 0 && per100g.protein === 0 && per100g.fat === 0 && per100g.carbs === 0 && queryIsZeroCalorie) ||
    (per100g.calories > 0 && macroCalories <= per100g.calories * 1.3 && macroPlausible);
  if (!sane) return null;

  return per100g;
}
