// One-time challenges for attestation enrollment (App Attest attestKey / Play Integrity).
// A challenge is random, short-lived, and single-use: the DB row is atomically flipped to
// consumed on first use, so it can never satisfy two enrollments (anti-replay at enroll time).
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/**
 * Issue a fresh single-use challenge (base64) for the given platform.
 * @param {string} platform 'ios' | 'android'
 * @returns {Promise<{challenge:string, expiresIn:number}>}
 */
export async function issueChallenge(platform) {
  const challenge = randomBytes(32).toString('base64');
  const ttl = config.auth.attestChallengeTtlSec;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  await query(
    `INSERT INTO attest_challenges (challenge, platform, expires_at) VALUES ($1, $2, $3)`,
    [challenge, platform ?? null, expiresAt],
  );
  return { challenge, expiresIn: ttl };
}

/**
 * Atomically consume a challenge. Returns true only if it existed, was unexpired, and had
 * not been consumed yet — the UPDATE ... WHERE consumed_at IS NULL makes this race-free.
 * @param {string} challenge
 * @returns {Promise<boolean>}
 */
export async function consumeChallenge(challenge) {
  if (typeof challenge !== 'string' || !challenge) return false;
  const { rows } = await query(
    `UPDATE attest_challenges
        SET consumed_at = now()
      WHERE challenge = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING challenge`,
    [challenge],
  );
  return rows.length > 0;
}

/** Remove expired/used challenges. Called periodically. */
export async function cleanupChallenges() {
  await query(`DELETE FROM attest_challenges WHERE expires_at < now() - interval '1 hour'`);
}

// Best-effort periodic cleanup (does not keep the process alive).
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const timer = setInterval(() => {
  cleanupChallenges().catch((e) => console.error('[attestChallenge] cleanup:', e.message));
}, CLEANUP_INTERVAL_MS);
timer.unref?.();
