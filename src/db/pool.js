// Postgres connection pool (stateless-friendly). Lazy initialization.
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: config.db.url });
    pool.on('error', (err) => {
      console.error('[db] неожиданная ошибка простаивающего клиента:', err.message);
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

// Ping for health-check. Returns true/false, does not throw.
export async function pingDb() {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[db] ping не прошёл:', err.message);
    return false;
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
