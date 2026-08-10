// Public authentication router: login via Apple/Google, refresh, logout, deletion.
// Mounted in server.js BEFORE authMiddleware — these endpoints do not require an existing session.
import { Router } from 'express';
import { verifyGoogleIdToken, exchangeGoogleCode } from '../services/googleIdentity.js';
import { verifyAppleIdentityToken, exchangeAppleCode } from '../services/appleIdentity.js';
import { upsertUserFromProvider, deleteUser } from '../services/users.js';
import { issueTokens, rotateRefresh, revokeRefresh, revokeAllForUser } from '../services/session.js';
import { requireUser } from '../middleware/requireUser.js';

export const authRouter = Router();

// POST /v1/auth/google  { idToken, nonce? }  — direct id_token (deprecated)
//                    or { code, codeVerifier, redirectUri } — PKCE authorization code flow
authRouter.post('/v1/auth/google', async (req, res, next) => {
  try {
    const { idToken, nonce, code, codeVerifier, redirectUri, clientId } = req.body ?? {};
    let sub, email;
    if (typeof code === 'string' && code) {
      ({ sub, email } = await exchangeGoogleCode(code, codeVerifier, redirectUri, clientId));
    } else if (typeof idToken === 'string' && idToken) {
      ({ sub, email } = await verifyGoogleIdToken(idToken, typeof nonce === 'string' ? nonce : undefined));
    } else {
      return res.status(400).json({ error: 'bad_request', message: 'нужен code или idToken' });
    }
    const userId = await upsertUserFromProvider('google', sub, email);
    const tokens = await issueTokens(userId);
    return res.json(tokens);
  } catch (err) {
    console.error('[auth/google]', err.message);
    return res.status(401).json({ error: 'auth_failed', message: 'Google-вход не удался' });
  }
});

// POST /v1/auth/apple  { identityToken?, code?, nonce? }
//   iOS-native → identityToken; Android web-OAuth → code.
authRouter.post('/v1/auth/apple', async (req, res, next) => {
  try {
    const { identityToken, code, nonce } = req.body ?? {};
    let identity;
    if (typeof identityToken === 'string' && identityToken) {
      identity = await verifyAppleIdentityToken(identityToken, typeof nonce === 'string' ? nonce : undefined);
    } else if (typeof code === 'string' && code) {
      identity = await exchangeAppleCode(code);
    } else {
      return res.status(400).json({ error: 'bad_request', message: 'нужен identityToken или code' });
    }
    const userId = await upsertUserFromProvider('apple', identity.sub, identity.email);
    const tokens = await issueTokens(userId);
    return res.json(tokens);
  } catch (err) {
    console.error('[auth/apple]', err.message);
    return res.status(401).json({ error: 'auth_failed', message: 'Apple-вход не удался' });
  }
});

// POST /v1/auth/apple/callback — web redirect target for Sign in with Apple (Android).
// Apple posts application/x-www-form-urlencoded { code, state, id_token?, user? } here
// (form_post mode). We exchange the code for identity, issue OUR session, then redirect
// back into the app via a custom-scheme deep link carrying the tokens.
// This URL is the Return URL registered in the Apple Services ID.
authRouter.post('/v1/auth/apple/callback', async (req, res) => {
  const appScheme = 'com.nutrition.tracker'; // app catches this deep link
  try {
    const { code } = req.body ?? {};
    if (typeof code !== 'string' || !code) {
      return res.redirect(302, `${appScheme}:/apple-auth?error=no_code`);
    }
    const identity = await exchangeAppleCode(code);
    const userId = await upsertUserFromProvider('apple', identity.sub, identity.email);
    const tokens = await issueTokens(userId);
    // Deep link back into the app with our session tokens.
    const params = new URLSearchParams({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: String(tokens.expiresIn ?? ''),
    });
    return res.redirect(302, `${appScheme}:/apple-auth?${params.toString()}`);
  } catch (err) {
    console.error('[auth/apple/callback]', err.message);
    return res.redirect(302, `${appScheme}:/apple-auth?error=auth_failed`);
  }
});

// POST /v1/auth/refresh  { refreshToken }
authRouter.post('/v1/auth/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(400).json({ error: 'bad_request', message: 'refreshToken обязателен' });
    }
    const tokens = await rotateRefresh(refreshToken);
    return res.json(tokens);
  } catch (err) {
    return res.status(401).json({ error: 'refresh_failed', message: 'refresh недействителен' });
  }
});

// POST /v1/auth/logout  { refreshToken }
authRouter.post('/v1/auth/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body ?? {};
    if (typeof refreshToken === 'string' && refreshToken) {
      await revokeRefresh(refreshToken);
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// DELETE /v1/auth/account — account deletion (Apple requirement). Requires Bearer.
authRouter.delete('/v1/auth/account', requireUser, async (req, res, next) => {
  try {
    await revokeAllForUser(req.userId);
    await deleteUser(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
