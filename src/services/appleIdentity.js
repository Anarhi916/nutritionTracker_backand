// Проверка Apple identity token (JWT) + web-OAuth обмен code→id_token (для Android).
// Возвращает { sub, email }. См. план — фаза аккаунтов.
import { createRemoteJWKSet, jwtVerify, SignJWT, importPKCS8 } from 'jose';
import { createHash } from 'node:crypto';
import { config } from '../config.js';

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const APPLE_ISSUER = 'https://appleid.apple.com';

// Допустимые aud: bundle ID (нативный iOS) + Services ID (web/Android flow).
function appleAudiences() {
  return [config.accounts.apple.bundleId, config.accounts.apple.servicesId].filter(Boolean);
}

/**
 * Проверка Apple identity JWT (от нативного iOS ASAuthorization или из code-обмена).
 * @param {string} identityToken
 * @param {string} [expectedNonce] — Apple кладёт SHA256(nonce) в claim `nonce`; сверку
 *        удобнее делать на клиенте/по сырому nonce, поэтому здесь опционально.
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
  // Нативный iOS кладёт в токен SHA256(nonce) hex; клиент шлёт сырой nonce.
  // Сверяем и с сырым (web-flow), и с sha256 (нативный).
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

// client_secret для Apple token endpoint — короткоживущий ES256-JWT, подписанный .p8.
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
    .setExpirationTime(now + 300) // 5 мин
    .setAudience(APPLE_ISSUER)
    .setSubject(servicesId)
    .sign(key);
}

/**
 * Web-OAuth flow (Android): обмениваем authorization code на id_token, затем верифицируем.
 * @param {string} code — authorization code от Apple.
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
