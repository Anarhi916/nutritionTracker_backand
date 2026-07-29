// Импорт USDA FDC CSV → Postgres.
// Импортирует Foundation + SR Legacy + FNDDS (эталонная еда, не Branded).
// Фильтрует food_nutrient только по нужным 33 нутриент-ID (см. db/nutrients.js).
//
// Запуск:  npm run import-usda
// Данные ожидаются в scripts/usda-data/<распакованные папки>/ (food.csv, food_nutrient.csv).

import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from '../src/db/pool.js';
import { NUTRIENT_ID_SET, ALLOWED_DATA_TYPES, resolveNutrientId } from '../src/db/nutrients.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'usda-data');
const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'db', 'schema.sql');

const BATCH_SIZE = 1000;

// --- Минимальный парсер одной CSV-строки (кавычки + запятые внутри) ---
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

// Батч-вставка foods
async function flushFoods(client, rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * 3;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
    params.push(r.fdcId, r.description, r.dataType);
  });
  await client.query(
    `INSERT INTO foods (fdc_id, description, data_type) VALUES ${values.join(',')}
     ON CONFLICT (fdc_id) DO NOTHING`,
    params,
  );
}

// Батч-вставка food_nutrients
async function flushNutrients(client, rows) {
  if (rows.length === 0) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * 3;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3})`);
    params.push(r.fdcId, r.nutrientId, r.value);
  });
  await client.query(
    `INSERT INTO food_nutrients (fdc_id, nutrient_id, value) VALUES ${values.join(',')}
     ON CONFLICT (fdc_id, nutrient_id) DO NOTHING`,
    params,
  );
}

async function importFoods(client, filePath, keptFdcIds) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let header = true;
  let batch = [];
  let total = 0;
  let kept = 0;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line.trim()) continue;
    total++;
    const cols = parseCsvLine(line);
    // food.csv: fdc_id, data_type, description, ...
    const fdcId = parseInt(cols[0], 10);
    const dataType = cols[1];
    const description = cols[2];
    if (!Number.isFinite(fdcId) || !ALLOWED_DATA_TYPES.has(dataType)) continue;
    keptFdcIds.add(fdcId);
    kept++;
    batch.push({ fdcId, description, dataType });
    if (batch.length >= BATCH_SIZE) {
      await flushFoods(client, batch);
      batch = [];
    }
  }
  await flushFoods(client, batch);
  console.log(`  food.csv: прочитано ${total}, импортировано ${kept}`);
}

async function importNutrients(client, filePath, keptFdcIds) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  let header = true;
  let batch = [];
  let total = 0;
  let kept = 0;
  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line.trim()) continue;
    total++;
    const cols = parseCsvLine(line);
    // food_nutrient.csv: id, fdc_id, nutrient_id, amount, ...
    // Foundation/SR: колонка 2 = FDC nutrient id (1008). FNDDS: = nutrient_nbr (208).
    const fdcId = parseInt(cols[1], 10);
    const value = parseFloat(cols[3]);
    if (!Number.isFinite(fdcId)) continue;
    const nutrientId = resolveNutrientId(cols[2]); // нормализуем к нашему id
    if (nutrientId === null) continue; // только нужные нутриенты
    if (!keptFdcIds.has(fdcId)) continue; // только для импортированной еды
    kept++;
    batch.push({ fdcId, nutrientId, value: Number.isFinite(value) ? value : null });
    if (batch.length >= BATCH_SIZE) {
      await flushNutrients(client, batch);
      batch = [];
    }
  }
  await flushNutrients(client, batch);
  console.log(`  food_nutrient.csv: прочитано ${total}, импортировано ${kept}`);
}

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // 1. Применить схему
    console.log('Применяю schema.sql...');
    const schema = await readFile(SCHEMA_PATH, 'utf8');
    await client.query(schema);

    // 2. Найти распакованные папки датасетов
    const entries = await readdir(DATA_DIR, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('FoodData_Central'))
      .map((e) => path.join(DATA_DIR, e.name));

    if (dirs.length === 0) {
      throw new Error(
        `Не найдено датасетов в ${DATA_DIR}. Распакуйте архивы USDA FDC туда.`,
      );
    }

    const keptFdcIds = new Set();

    // 3. Сначала все foods (наполняем keptFdcIds), потом все nutrients
    for (const dir of dirs) {
      console.log(`\n[${path.basename(dir)}] foods...`);
      await importFoods(client, path.join(dir, 'food.csv'), keptFdcIds);
    }
    for (const dir of dirs) {
      console.log(`\n[${path.basename(dir)}] nutrients...`);
      await importNutrients(client, path.join(dir, 'food_nutrient.csv'), keptFdcIds);
    }

    // 4. Итоговые счётчики
    const foodsCount = await client.query('SELECT count(*) FROM foods');
    const nutrientsCount = await client.query('SELECT count(*) FROM food_nutrients');
    console.log('\n=== ГОТОВО ===');
    console.log(`foods:          ${foodsCount.rows[0].count}`);
    console.log(`food_nutrients: ${nutrientsCount.rows[0].count}`);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch((err) => {
  console.error('Ошибка импорта:', err);
  process.exit(1);
});
