// Verification of the Apple identity token (JWT) + web-OAuth exchange code→id_token (for Android).
// Returns { sub, email }. See the plan — accounts phase.
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const APPLE_ISSUER = 'https://appleid.apple.com';

// Allowed aud: bundle ID (native iOS) + Services ID (web/Android flow).
function appleAudiences() {
  return [config.accounts.apple.bundleId, config.accounts.apple.servicesId].filter(Boolean);
}

/**
 * Verification of the Apple identity JWT (from native iOS ASAuthorization or from the code exchange).
 * @param {string} identityToken
 * @param {string} [expectedNonce] — Apple puts SHA256(nonce) in the `nonce` claim; it is
 *        more convenient to verify on the client/against the raw nonce, so here it is optional.
 * @returns {Promise<{ sub: string, email: string|null }>}
 */
export async function verifyAppleIdentityToken(identityToken, expectedNonce) {
  const audience = appleAudiences();
  if (!audience.length) {
    throw new Error('Apple bundleId/servicesId не настроены');
  }
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience,
  });
  // Native iOS puts SHA256(nonce) hex in the token; the client sends the raw nonce.
  // We check against both the raw one (web-flow) and sha256 (native).
  if (expectedNonce && payload.nonce) {
    const sha = createHash('sha256').update(expectedNonce).digest('hex');
    if (payload.nonce !== expectedNonce && payload.nonce !== sha) {
      throw new Error('nonce не совпал');
    }
  }
  if (!payload.sub) {
    throw new Error('в токене нет sub');
  }
  return {
    sub: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : null,
  };
}

// client_secret for the Apple token endpoint — a short-lived ES256 JWT signed with the .p8.
async function makeAppleClientSecret() {
  const { teamId, keyId, privateKey, servicesId } = config.accounts.apple;
  if (!teamId || !keyId || !privateKey || !servicesId) {
    throw new Error('Apple web-OAuth не настроен (teamId/keyId/privateKey/servicesId)');
  }
  const key = await importPKCS8(privateKey, 'ES256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300) // 5 min
    .setAudience(APPLE_ISSUER)
    .setSubject(servicesId)
    .sign(key);
}

/**
 * Web-OAuth flow (Android): exchange the authorization code for an id_token, then verify it.
 * @param {string} code — authorization code from Apple.
 * @returns {Promise<{ sub: string, email: string|null }>}
 */
export async function exchangeAppleCode(code) {
  const clientSecret = await makeAppleClientSecret();
  const body = new URLSearchParams({
    client_id: config.accounts.apple.servicesId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.accounts.apple.redirectUri,
  });
  const resp = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Apple token endpoint ${resp.status}: ${text}`);
  }
  const json = await resp.json();
  if (!json.id_token) {
    throw new Error('Apple не вернул id_token');
  }
  return verifyAppleIdentityToken(json.id_token);
}
