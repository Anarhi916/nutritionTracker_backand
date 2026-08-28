// Session layer: our access-JWT (HS256) + refresh tokens (we store sha256 in the DB).
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';

const secretKey = new TextEncoder().encode(config.accounts.jwtSecret);
const JWT_ISSUER = 'nutritiontracker-backend';
const JWT_AUDIENCE = 'nutritiontracker-client';

function sha256(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/** Issue an access-JWT (short-lived) + a refresh token (random, hash in the DB). */
export async function issueTokens(userId) {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
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

/** Verify the access-JWT. Returns userId or throws. */
export async function verifyAccess(token) {
  const { payload } = await jwtVerify(token, secretKey, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  if (!payload.sub) throw new Error('нет sub');
  return String(payload.sub);
}

/** Refresh rotation: validate the old one, delete it, issue a new pair. */
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

/** Revoke a single refresh token (logout). */
export async function revokeRefresh(rawRefresh) {
  await query(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [sha256(rawRefresh)]);
}

/** Revoke all of a user's refresh tokens. */
export async function revokeAllForUser(userId) {
  await query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]);
}
