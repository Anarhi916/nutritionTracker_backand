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

  // 2) linking by email (if the provider gave an email and one already exists)
  if (email) {
    const byEmail = await query(
      `SELECT id FROM users WHERE email = $1 AND ${subCol} IS NULL LIMIT 1`,
      [email],
    );
    if (byEmail.rows.length) {
      const id = byEmail.rows[0].id;
      await query(
        `UPDATE users SET ${subCol} = $2, last_login_at = now() WHERE id = $1`,
        [id, sub],
      );
      return id;
    }
  }

  // 3) new user
  const created = await query(
    `INSERT INTO users (${subCol}, email, last_login_at)
       VALUES ($1, $2, now()) RETURNING id`,
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
