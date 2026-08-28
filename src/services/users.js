// Working with the users table: upsert by provider, linking Apple+Google by email.
import { query } from '../db/pool.js';

/**
 * Find/create a user from provider data.
 * provider: 'apple' | 'google'. Returns users.id.
 *
 * Linking logic:
 *  1) there is a row with this *_sub → it's them, update last_login (+ email if empty).
 *  2) otherwise if there is an email and a row with that email → attach *_sub to it.
 *  3) otherwise create a new row.
 */
export async function upsertUserFromProvider(provider, sub, email) {
  const subCol = provider === 'apple' ? 'apple_sub' : 'google_sub';

  // 1) by sub
  const bySub = await query(`SELECT id FROM users WHERE ${subCol} = $1`, [sub]);
  if (bySub.rows.length) {
    const id = bySub.rows[0].id;
    await query(
      `UPDATE users SET last_login_at = now(),
         email = COALESCE(email, $2)
       WHERE id = $1`,
      [id, email],
    );
    return id;
  }

  // 2) linking by email (if the provider gave an email and one already exists).
  //    The UPDATE is guarded by `${subCol} IS NULL` so two providers can't stomp
  //    each other, and we check the row count: if the matched row vanished between
  //    SELECT and UPDATE (concurrent deletion), fall through to insert instead of
  //    returning a stale id that would break issueTokens with an FK violation.
  if (email) {
    const byEmail = await query(
      `SELECT id FROM users WHERE email = $1 AND ${subCol} IS NULL LIMIT 1`,
      [email],
    );
    if (byEmail.rows.length) {
      const id = byEmail.rows[0].id;
      const linked = await query(
        `UPDATE users SET ${subCol} = $2, last_login_at = now()
           WHERE id = $1 AND ${subCol} IS NULL
         RETURNING id`,
        [id, sub],
      );
      if (linked.rows.length) return id;
      // Row changed under us — re-resolve by sub (another request just linked it).
      const reBySub = await query(`SELECT id FROM users WHERE ${subCol} = $1`, [sub]);
      if (reBySub.rows.length) return reBySub.rows[0].id;
    }
  }

  // 3) new user — atomic against a concurrent first-login for the same account.
  //    ON CONFLICT on the provider sub turns the UNIQUE-violation race into an
  //    idempotent upsert instead of an unhandled 500.
  const created = await query(
    `INSERT INTO users (${subCol}, email, last_login_at)
       VALUES ($1, $2, now())
     ON CONFLICT (${subCol}) DO UPDATE
       SET last_login_at = now(),
           email = COALESCE(users.email, EXCLUDED.email)
     RETURNING id`,
    [sub, email],
  );
  return created.rows[0].id;
}

/** Delete the account entirely (cascades to refresh_tokens). */
export async function deleteUser(userId) {
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
}

// Whether the user exists (for requireUser — the token is valid, but the account may have been deleted).
export async function userExists(userId) {
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  return rows.length > 0;
}
