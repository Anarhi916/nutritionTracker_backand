// Applies src/db/schema.sql to the main DB (idempotent). Separate from import-usda.js,
// so as not to run the USDA import just to update the schema (e.g. adding users).
//   node scripts/apply-schema.js          → DATABASE_URL
//   node scripts/apply-schema.js --test    → TEST_DATABASE_URL
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { config } from '../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, '..', 'src', 'db', 'schema.sql');

async function main() {
  const useTest = process.argv.includes('--test');
  const connectionString = useTest ? config.db.testUrl : config.db.url;
  console.log(`Применяю schema.sql к ${useTest ? 'TEST' : 'MAIN'} БД: ${connectionString}`);

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const schema = await readFile(SCHEMA_PATH, 'utf8');
    await client.query(schema);
    console.log('Схема применена успешно.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Ошибка применения схемы:', err);
  process.exit(1);
});
