// Public attestation router: challenge issuance + App Attest enrollment.
// Mounted in server.js BEFORE authMiddleware — enrollment must be reachable before a device
// can produce assertions (chicken-and-egg). Self-protecting: bad attestations are rejected.
import { Router } from 'express';
import { issueChallenge } from '../services/attestChallenge.js';
import { registerAppAttestKey } from '../services/appAttest.js';

export const attestRouter = Router();

// POST /v1/attest/challenge  { platform? } → { challenge, expiresIn }
// One-time challenge for App Attest enrollment (attestKey clientDataHash = SHA256(challenge)).
attestRouter.post('/v1/attest/challenge', async (req, res, next) => {
  try {
    const platform = (req.get('X-Platform') || req.body?.platform || '').toString().toLowerCase();
    const out = await issueChallenge(platform || null);
    return res.json(out);
  } catch (err) {
    return next(err);
  }
});

// POST /v1/attest/apple/register  { keyId, attestation, challenge } → { ok } | 400
// Verifies the attestation object and stores the device public key.
attestRouter.post('/v1/attest/apple/register', async (req, res, next) => {
  try {
    const { keyId, attestation, challenge } = req.body ?? {};
    const result = await registerAppAttestKey({ keyId, attestation, challenge });
    if (!result.ok) {
      return res.status(400).json({ error: 'attest_failed', message: result.reason });
    }
    return res.json({ ok: true, environment: result.environment });
  } catch (err) {
    console.error('[attest/apple/register]', err.message);
    return res.status(400).json({ error: 'attest_failed', message: 'регистрация не удалась' });
  }
});
