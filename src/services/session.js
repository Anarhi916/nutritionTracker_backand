// Сессионный слой: наш access-JWT (HS256) + refresh-токены (в БД храним sha256).
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const secretKey = new TextEncoder().encode(config.accounts.jwtSecret);

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/** Выпустить access-JWT (короткий) + refresh-токен (случайный, хэш в БД). */
export async function issueTokens(userId) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + config.accounts.accessTtlSec)
    .sign(secretKey);

  const refreshToken = randomBytes(32).toString('hex');
  const expiresAt = new Date((now + config.accounts.refreshTtlSec) * 1000);
  await query(
    `INSERT INTO refresh_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [sha256(refreshToken), userId, expiresAt],
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: config.accounts.accessTtlSec,
  };
}

/** Проверить access-JWT. Возвращает userId или бросает. */
export async function verifyAccess(token) {
  const { payload } = await jwtVerify(token, secretKey);
  if (!payload.sub) throw new Error('нет sub');
  return String(payload.sub);
}

/** Ротация refresh: валидируем старый, удаляем, выдаём новую пару. */
export async function rotateRefresh(rawRefresh) {
  const hash = sha256(rawRefresh);
  const { rows } = await query(
    `DELETE FROM refresh_tokens
       WHERE token_hash = $1 AND expires_at > now()
       RETURNING user_id`,
    [hash],
  );
  if (!rows.length) {
    throw new Error('refresh-токен недействителен или истёк');
  }
  return issueTokens(rows[0].user_id);
}

/** Отозвать один refresh-токен (logout). */
export async function revokeRefresh(rawRefresh) {
  await query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [sha256(rawRefresh)]);
}

/** Отозвать все refresh-токены пользователя. */
export async function revokeAllForUser(userId) {
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}
