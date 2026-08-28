import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';

const GOOGLE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/oauth2/v3/certs'),
);
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export async function verifyGoogleIdToken(idToken, expectedNonce) {
  const audience = config.accounts.google.clientIds;
  if (!audience.length) throw new Error('Google client IDs not configured');
  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience,
  });
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('nonce mismatch');
  if (!payload.sub) throw new Error('no sub in token');
  return { sub: String(payload.sub), email: typeof payload.email === 'string' ? payload.email : null };
}

// Exchange PKCE authorization code for id_token.
// Uses the client_id sent by the client (iOS public client — no secret required).
export async function exchangeGoogleCode(code, codeVerifier, redirectUri, clientId) {
  const resolvedClientId = clientId || process.env.GOOGLE_CLIENT_ID_IOS;
  if (!resolvedClientId) throw new Error('No Google client ID for token exchange');
  // Only exchange with a client_id we own — never make an outbound token request
  // to Google on behalf of an attacker-supplied client_id.
  if (!config.accounts.google.clientIds.includes(resolvedClientId)) {
    throw new Error('Unknown Google client ID');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: resolvedClientId,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await resp.json();
  if (!resp.ok || !data.id_token) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  }
  return verifyGoogleIdToken(data.id_token);
}
