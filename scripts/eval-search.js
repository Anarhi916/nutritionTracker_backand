// Оценщик качества ранжирования usdaSearch на размеченном наборе.
// Читает cases из scripts/testset.json: [{query, expectRegex, note}].
// Печатает top-1 / top-5 hit rate и список провалов.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchFoods } from '../src/services/usdaSearch.js';
import { closePool } from '../src/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SET_PATH = path.join(__dirname, 'testset.json');

const cases = JSON.parse(await readFile(SET_PATH, 'utf8'));

let top1 = 0;
let top5 = 0;
const failures = [];

for (const c of cases) {
  const re = new RegExp(c.expectRegex, 'i');
  const results = await searchFoods(c.query, 5);
  const hitIdx = results.findIndex((r) => re.test(r.description));
  if (hitIdx === 0) top1 += 1;
  if (hitIdx >= 0 && hitIdx < 5) top5 += 1;
  if (hitIdx !== 0) {
    failures.push({
      query: c.query,
      expect: c.expectRegex,
      hitIdx,
      top3: results.slice(0, 3).map((r) => r.description),
    });
  }
}

const n = cases.length;
console.log(`\n=== РЕЗУЛЬТАТ (${n} кейсов) ===`);
console.log(`top-1: ${top1}/${n} (${((top1 / n) * 100).toFixed(1)}%)`);
console.log(`top-5: ${top5}/${n} (${((top5 / n) * 100).toFixed(1)}%)`);

if (failures.length) {
  console.log(`\n=== ПРОВАЛЫ top-1 (${failures.length}) ===`);
  for (const f of failures) {
    const where = f.hitIdx < 0 ? 'НЕ в топ-5' : `на позиции ${f.hitIdx + 1}`;
    console.log(`\n"${f.query}"  (ожидали /${f.expect}/) — ${where}`);
    f.top3.forEach((d, i) => console.log(`   ${i + 1}. ${d}`));
  }
}

await closePool();
