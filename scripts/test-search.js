// CLI-тестер ранжирования usdaSearch. Печатает топ-N кандидатов для запросов.
// Запуск:  node scripts/test-search.js "buckwheat cooked" "chicken breast" ...
// Без аргументов — прогоняет встроенный набор.

import { searchFoods } from '../src/services/usdaSearch.js';
import { closePool } from '../src/db/pool.js';

const DEFAULT_QUERIES = [
  'buckwheat cooked',
  'chicken breast',
  'white rice cooked',
  'egg',
  'whole milk',
  'salmon',
  'apple raw',
  'ground beef',
  'banana raw',
  'potato boiled',
  'oatmeal cooked',
  'cheddar cheese',
  'carrot raw',
  'lentils cooked',
  'almonds',
];

const queries = process.argv.slice(2);
const list = queries.length > 0 ? queries : DEFAULT_QUERIES;
const TOP = 5;

for (const q of list) {
  const results = await searchFoods(q, TOP);
  console.log(`\n### "${q}"`);
  if (results.length === 0) {
    console.log('  (нет результатов)');
    continue;
  }
  results.forEach((r, i) => {
    console.log(
      `  ${i + 1}. [${r.score.toFixed(3)}] ${r.description}  (${r.dataType}, fdc=${r.fdcId})`,
    );
  });
}

await closePool();
