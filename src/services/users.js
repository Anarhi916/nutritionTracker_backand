// Работа с таблицей users: upsert по провайдеру, связывание Apple+Google по email.
import { query } from '../db/pool.js';

/**
 * Найти/создать пользователя по данным провайдера.
 * provider: 'apple' | 'google'. Возвращает users.id.
 *
 * Логика связывания:
 *  1) есть ряд с этим *_sub → это он, обновляем last_login (+ email если пуст).
 *  2) иначе если есть email и ряд с таким email → доклеиваем *_sub к нему.
 *  3) иначе создаём новый ряд.
 */
export async function upsertUserFromProvider(provider, sub, email) {
  const subCol = provider === 'apple' ? 'apple_sub' : 'google_sub';

  // 1) по sub
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

  // 2) связывание по email (если провайдер дал email и такой уже есть)
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

  // 3) новый пользователь
  const created = await query(
    `INSERT INTO users (${subCol}, email, last_login_at)
       VALUES ($1, $2, now()) RETURNING id`,
    [sub, email],
  );
  return created.rows[0].id;
}

/** Удалить аккаунт целиком (каскадно снесёт refresh_tokens). */
export async function deleteUser(userId) {
  await query(`DELETE FROM users WHERE id = $1`, [userId]);
}

// Существует ли пользователь (для requireUser — токен валиден, но аккаунт мог быть удалён).
export async function userExists(userId) {
  const { rows } = await query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
  return rows.length > 0;
}
