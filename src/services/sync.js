// Synchronization of user data across devices.
// Strategy: server-as-source-of-truth, last-write-wins by updated_at (client time).
// IMPORTANT: the delta cursor (since/serverTime) is computed by server_updated_at — the server
// clock, set on every upsert. This removes the dependency on clock skew
// between devices (otherwise a record created "in the past" by the client clock,
// but uploaded later, would slip past since). See sync-architecture (memory).
import { query, getPool } from '../db/pool.js';

// --- Time conversion helpers ---

// epoch-ms (number) → ISO for TIMESTAMPTZ; null-safe.
function msToIso(ms) {
  if (ms == null) return null;
  return new Date(Number(ms)).toISOString();
}

// TIMESTAMPTZ (Date from pg) → epoch-ms number; null-safe.
function isoToMs(d) {
  if (d == null) return null;
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

// ---------------------------------------------------------------------------
// PUSH — accept the delta from the client and write it (last-write-wins by updated_at).
// server_updated_at on each successful upsert = now() (server clock).
// body: { profile?, norms?, entries?[], foodCache?[] }
// ---------------------------------------------------------------------------
export async function pushSync(userId, body) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // --- profile (1 row) ---
    if (body.profile) {
      const p = body.profile;
      await client.query(
        `INSERT INTO sync_profiles (user_id, gender, age, weight_kg, height_cm, goals_text, updated_at, deleted_at, server_updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (user_id) DO UPDATE SET
           gender=EXCLUDED.gender, age=EXCLUDED.age, weight_kg=EXCLUDED.weight_kg,
           height_cm=EXCLUDED.height_cm, goals_text=EXCLUDED.goals_text,
           updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at,
           server_updated_at=now()
         WHERE EXCLUDED.updated_at >= sync_profiles.updated_at`,
        [userId, p.gender, p.age, p.weightKg, p.heightCm, p.goalsText,
         msToIso(p.updatedAt), msToIso(p.deletedAt)],
      );
    }

    // --- norms (1 row) ---
    if (body.norms) {
      const n = body.norms;
      await client.query(
        `INSERT INTO sync_norms (user_id, nutrients, updated_at, deleted_at, server_updated_at)
           VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (user_id) DO UPDATE SET
           nutrients=EXCLUDED.nutrients, updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at,
           server_updated_at=now()
         WHERE EXCLUDED.updated_at >= sync_norms.updated_at`,
        [userId, n.nutrientsJson, msToIso(n.updatedAt), msToIso(n.deletedAt)],
      );
    }

    // --- food entries (many rows, idempotency by client_id) ---
    if (Array.isArray(body.entries)) {
      for (const e of body.entries) {
        if (!e.clientId) continue;
        await client.query(
          `INSERT INTO sync_food_entries
             (user_id, client_id, date, food_name, food_name_en, weight_grams,
              nutrients_json, source, from_cache, created_at, updated_at, deleted_at, server_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, now()),$11,$12, now())
           ON CONFLICT (user_id, client_id) DO UPDATE SET
             date=EXCLUDED.date, food_name=EXCLUDED.food_name, food_name_en=EXCLUDED.food_name_en,
             weight_grams=EXCLUDED.weight_grams, nutrients_json=EXCLUDED.nutrients_json,
             source=EXCLUDED.source, from_cache=EXCLUDED.from_cache,
             updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at,
             server_updated_at=now()
           WHERE EXCLUDED.updated_at >= sync_food_entries.updated_at`,
          [userId, e.clientId, e.date, e.foodName, e.foodNameEn ?? '', e.weightGrams,
           e.nutrientsJson, e.source ?? 'manual', e.fromCache ?? false,
           msToIso(e.createdAt), msToIso(e.updatedAt), msToIso(e.deletedAt)],
        );
      }
    }

    // --- food cache / saved products (idempotency by key_normalized) ---
    if (Array.isArray(body.foodCache)) {
      for (const c of body.foodCache) {
        if (!c.keyNormalized) continue;
        await client.query(
          `INSERT INTO sync_food_cache
             (user_id, key_normalized, key_original, key_en, key_en_normalized,
              nutrients_json, created_at, updated_at, deleted_at, server_updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, now()),$8,$9, now())
           ON CONFLICT (user_id, key_normalized) DO UPDATE SET
             key_original=EXCLUDED.key_original, key_en=EXCLUDED.key_en,
             key_en_normalized=EXCLUDED.key_en_normalized, nutrients_json=EXCLUDED.nutrients_json,
             updated_at=EXCLUDED.updated_at, deleted_at=EXCLUDED.deleted_at,
             server_updated_at=now()
           WHERE EXCLUDED.updated_at >= sync_food_cache.updated_at`,
          [userId, c.keyNormalized, c.keyOriginal, c.keyEn ?? '', c.keyEnNormalized ?? '',
           c.nutrientsJson, msToIso(c.createdAt), msToIso(c.updatedAt), msToIso(c.deletedAt)],
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// PULL — return the user's data. since=null → everything (full); otherwise a delta by
// server_updated_at (server clock). serverTime in the response = the MAXIMUM
// server_updated_at among the returned rows (not Date.now()!) — this guarantees the
// client cursor does not "jump over" a record uploaded from another device later.
// ---------------------------------------------------------------------------
export async function pullSync(userId, sinceMs) {
  const sinceIso = sinceMs != null ? msToIso(sinceMs) : null;
  const whereSince = sinceIso ? 'AND server_updated_at > $2' : '';
  const params = sinceIso ? [userId, sinceIso] : [userId];

  const [profileRes, normsRes, entriesRes, cacheRes] = await Promise.all([
    query(`SELECT * FROM sync_profiles WHERE user_id = $1 ${whereSince}`, params),
    query(`SELECT * FROM sync_norms WHERE user_id = $1 ${whereSince}`, params),
    query(`SELECT * FROM sync_food_entries WHERE user_id = $1 ${whereSince}
             ORDER BY server_updated_at ASC`, params),
    query(`SELECT * FROM sync_food_cache WHERE user_id = $1 ${whereSince}
             ORDER BY server_updated_at ASC`, params),
  ]);

  // serverTime = the maximum server_updated_at among all returned rows.
  // If nothing was returned — do not move the client cursor (return the previous since,
  // or now() on a full-pull with no data — moving it there is safe).
  let maxServerMs = sinceMs ?? 0;
  const bump = (d) => { const ms = isoToMs(d); if (ms != null && ms > maxServerMs) maxServerMs = ms; };
  for (const r of profileRes.rows) bump(r.server_updated_at);
  for (const r of normsRes.rows) bump(r.server_updated_at);
  for (const r of entriesRes.rows) bump(r.server_updated_at);
  for (const r of cacheRes.rows) bump(r.server_updated_at);

  const profile = profileRes.rows[0] ? {
    gender: profileRes.rows[0].gender,
    age: profileRes.rows[0].age,
    weightKg: profileRes.rows[0].weight_kg,
    heightCm: profileRes.rows[0].height_cm,
    goalsText: profileRes.rows[0].goals_text,
    updatedAt: isoToMs(profileRes.rows[0].updated_at),
    deletedAt: isoToMs(profileRes.rows[0].deleted_at),
  } : null;

  const norms = normsRes.rows[0] ? {
    nutrientsJson: typeof normsRes.rows[0].nutrients === 'string'
      ? normsRes.rows[0].nutrients : JSON.stringify(normsRes.rows[0].nutrients),
    updatedAt: isoToMs(normsRes.rows[0].updated_at),
    deletedAt: isoToMs(normsRes.rows[0].deleted_at),
  } : null;

  const entries = entriesRes.rows.map((r) => ({
    clientId: r.client_id,
    date: r.date,
    foodName: r.food_name,
    foodNameEn: r.food_name_en,
    weightGrams: r.weight_grams,
    nutrientsJson: r.nutrients_json,
    source: r.source,
    fromCache: r.from_cache,
    createdAt: isoToMs(r.created_at),
    updatedAt: isoToMs(r.updated_at),
    deletedAt: isoToMs(r.deleted_at),
  }));

  const foodCache = cacheRes.rows.map((r) => ({
    keyNormalized: r.key_normalized,
    keyOriginal: r.key_original,
    keyEn: r.key_en,
    keyEnNormalized: r.key_en_normalized,
    nutrientsJson: r.nutrients_json,
    createdAt: isoToMs(r.created_at),
    updatedAt: isoToMs(r.updated_at),
    deletedAt: isoToMs(r.deleted_at),
  }));

  // full-pull with no data → return now() (moving the cursor is safe, there are no records).
  const serverTime = (sinceMs == null && maxServerMs === 0) ? Date.now() : maxServerMs;
  return { profile, norms, entries, foodCache, serverTime };
}
