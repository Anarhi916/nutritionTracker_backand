// Play Integrity (Android) verification. SKELETON — real verification is enabled before
// release (requires a Play-signed APK + Google Cloud credentials).
//
// Full flow (once activated):
//   1. The client requests an Integrity Token from the Play Integrity API (with a server nonce).
//   2. The client sends the token to the server (X-Integrity-Token).
//   3. The server decrypts/verifies the token via the Google Play Integrity API
//      (google-auth-library + Play Integrity decode endpoint or local decryption
//      with a server key). We check:
//        - appRecognitionVerdict == PLAY_RECOGNIZED
//        - packageName == GOOGLE_PACKAGE_NAME
//        - nonce matches (anti-replay)
//        - (opt.) deviceRecognitionVerdict / MEETS_DEVICE_INTEGRITY
//
// Headers (once activated): X-Integrity-Token, X-Integrity-Nonce.
import { config } from '../config.js';

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyPlayIntegrity(req) {
  // TODO(release): implement Integrity Token verification.
  // For now prod mode deliberately rejects Android until verification is activated.
  if (!config.auth.googleProjectNumber) {
    return { ok: false, reason: 'Play Integrity не сконфигурирован (GOOGLE_CLOUD_PROJECT_NUMBER пуст)' };
  }
  const token = req.get('X-Integrity-Token');
  if (!token) return { ok: false, reason: 'нет X-Integrity-Token' };
  return { ok: false, reason: 'Play Integrity верификация ещё не активирована (каркас)' };
}
