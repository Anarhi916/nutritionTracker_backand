// 33 USDA FDC nutrient IDs that the client reads (see ARCHITECTURE.md).
// The client decodes the response by nutrientId → value; metadata (name/number/unit)
// is kept here statically so as not to bloat the DB.
//
// Key = field name in the client NutrientData (snake_case, as in prompts/JSON).

export const NUTRIENTS = [
  // --- Macros ---
  { id: 1008, key: 'calories', name: 'Energy', number: '208', unit: 'KCAL' },
  { id: 1003, key: 'protein', name: 'Protein', number: '203', unit: 'G' },
  { id: 1004, key: 'fat', name: 'Total lipid (fat)', number: '204', unit: 'G' },
  { id: 1258, key: 'saturated_fat', name: 'Fatty acids, total saturated', number: '606', unit: 'G' },
  { id: 1292, key: 'monounsaturated_fat', name: 'Fatty acids, total monounsaturated', number: '645', unit: 'G' },
  { id: 1293, key: 'polyunsaturated_fat', name: 'Fatty acids, total polyunsaturated', number: '646', unit: 'G' },
  { id: 1253, key: 'cholesterol', name: 'Cholesterol', number: '601', unit: 'MG' },
  { id: 1005, key: 'carbs', name: 'Carbohydrate, by difference', number: '205', unit: 'G' },
  { id: 1079, key: 'fiber', name: 'Fiber, total dietary', number: '291', unit: 'G' },

  // --- Vitamins ---
  { id: 1106, key: 'vitamin_a', name: 'Vitamin A, RAE', number: '320', unit: 'UG' },
  { id: 1165, key: 'vitamin_b1', name: 'Thiamin', number: '404', unit: 'MG' },
  { id: 1166, key: 'vitamin_b2', name: 'Riboflavin', number: '405', unit: 'MG' },
  { id: 1167, key: 'vitamin_b3', name: 'Niacin', number: '406', unit: 'MG' },
  { id: 1170, key: 'vitamin_b5', name: 'Pantothenic acid', number: '410', unit: 'MG' },
  { id: 1175, key: 'vitamin_b6', name: 'Vitamin B-6', number: '415', unit: 'MG' },
  { id: 1176, key: 'vitamin_b7', name: 'Biotin', number: '416', unit: 'UG' },
  { id: 1177, key: 'vitamin_b9', name: 'Folate, total', number: '417', unit: 'UG' },
  { id: 1178, key: 'vitamin_b12', name: 'Vitamin B-12', number: '418', unit: 'UG' },
  { id: 1162, key: 'vitamin_c', name: 'Vitamin C, total ascorbic acid', number: '401', unit: 'MG' },
  { id: 1114, key: 'vitamin_d', name: 'Vitamin D (D2 + D3)', number: '328', unit: 'UG' },
  { id: 1109, key: 'vitamin_e', name: 'Vitamin E (alpha-tocopherol)', number: '323', unit: 'MG' },
  { id: 1185, key: 'vitamin_k', name: 'Vitamin K (phylloquinone)', number: '430', unit: 'UG' },

  // --- Minerals ---
  { id: 1087, key: 'calcium', name: 'Calcium, Ca', number: '301', unit: 'MG' },
  { id: 1089, key: 'iron', name: 'Iron, Fe', number: '303', unit: 'MG' },
  { id: 1090, key: 'magnesium', name: 'Magnesium, Mg', number: '304', unit: 'MG' },
  { id: 1091, key: 'phosphorus', name: 'Phosphorus, P', number: '305', unit: 'MG' },
  { id: 1092, key: 'potassium', name: 'Potassium, K', number: '306', unit: 'MG' },
  { id: 1093, key: 'sodium', name: 'Sodium, Na', number: '307', unit: 'MG' },
  { id: 1095, key: 'zinc', name: 'Zinc, Zn', number: '309', unit: 'MG' },
  { id: 1098, key: 'copper', name: 'Copper, Cu', number: '312', unit: 'MG' },
  { id: 1101, key: 'manganese', name: 'Manganese, Mn', number: '315', unit: 'MG' },
  { id: 1103, key: 'selenium', name: 'Selenium, Se', number: '317', unit: 'UG' },
  { id: 1100, key: 'iodine', name: 'Iodine, I', number: '314', unit: 'UG' },
];

// Set of IDs for fast filtering during import.
export const NUTRIENT_ID_SET = new Set(NUTRIENTS.map((n) => n.id));

// nutrient-ID constants by UPPER_SNAKE name (as UsdaFoodNutrient in the client).
// Used by buildNutrientsFromUsda: NUTRIENT_ID.ENERGY === 1008, etc.
export const NUTRIENT_ID = {
  ENERGY: 1008, PROTEIN: 1003, FAT: 1004, SATURATED_FAT: 1258,
  MONOUNSATURATED_FAT: 1292, POLYUNSATURATED_FAT: 1293, CHOLESTEROL: 1253,
  CARBS: 1005, FIBER: 1079, VITAMIN_A: 1106, VITAMIN_B1: 1165, VITAMIN_B2: 1166,
  VITAMIN_B3: 1167, VITAMIN_B5: 1170, VITAMIN_B6: 1175, VITAMIN_B7: 1176,
  VITAMIN_B9: 1177, VITAMIN_B12: 1178, VITAMIN_C: 1162, VITAMIN_D: 1114,
  VITAMIN_E: 1109, VITAMIN_K: 1185, CALCIUM: 1087, IRON: 1089, MAGNESIUM: 1090,
  PHOSPHORUS: 1091, POTASSIUM: 1092, SODIUM: 1093, ZINC: 1095, COPPER: 1098,
  MANGANESE: 1101, SELENIUM: 1103, IODINE: 1100,
};

// Map id → metadata (for building UsdaSearchResponse in task 4).
export const NUTRIENT_BY_ID = new Map(NUTRIENTS.map((n) => [n.id, n]));

// Map nutrient_number (string, e.g. '208') → FDC id (1008).
// FNDDS/survey references nutrients by nutrient_nbr, not by the internal id;
// the importer normalizes them to our id.
export const NUTRIENT_ID_BY_NUMBER = new Map(NUTRIENTS.map((n) => [n.number, n.id]));

// Resolves a raw value from food_nutrient.csv to our FDC id.
// Foundation/SR: value is already = id (1008). FNDDS: value = nutrient_nbr (208).
// Returns an id from our set or null.
export function resolveNutrientId(raw) {
  const asInt = parseInt(raw, 10);
  if (Number.isFinite(asInt) && NUTRIENT_ID_SET.has(asInt)) return asInt;
  const byNbr = NUTRIENT_ID_BY_NUMBER.get(String(raw));
  return byNbr ?? null;
}

// USDA data types that we import (reference foods, not Branded).
export const ALLOWED_DATA_TYPES = new Set([
  'foundation_food',
  'sr_legacy_food',
  'survey_fndds_food',
]);
