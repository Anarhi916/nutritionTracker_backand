// App Attest (iOS) verification. SKELETON — real crypto verification is enabled before
// release (requires physical devices: attestation cannot be reproduced on a simulator).
//
// Full flow (once activated):
//   1. Key registration: the client sends the attestation object (CBOR) + keyId.
//      We validate: the certificate chain up to the Apple App Attest Root CA, that the nonce
//      matches, the App ID (APPLE_TEAM_ID + APPLE_BUNDLE_ID), counter=0. We store
//      the public key by keyId.
//   2. Each request: the client sends an assertion (signature of the body + counter). We verify
//      the signature with the public key, that the counter grows monotonically (anti-replay).
//
// Headers (once activated): X-Attest-KeyId, X-Attest-Assertion, X-Attest-Object (on registration).
// Candidate libraries: node-app-attest / a custom implementation based on Apple docs.
import { config } from '../config.js';

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyAppAttest(req) {
  // TODO(release): implement attestation/assertion verification.
  // For now prod mode deliberately rejects iOS until crypto verification is activated,
  // so as NOT to let unauthenticated requests through under the guise of working protection.
  if (!config.auth.appleTeamId) {
    return { ok: false, reason: 'App Attest не сконфигурирован (APPLE_TEAM_ID пуст)' };
  }
  const keyId = req.get('X-Attest-KeyId');
  if (!keyId) return { ok: false, reason: 'нет X-Attest-KeyId' };
  return { ok: false, reason: 'App Attest верификация ещё не активирована (каркас)' };
}
