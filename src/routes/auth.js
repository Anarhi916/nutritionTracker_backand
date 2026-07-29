// Публичный роутер аутентификации: вход через Apple/Google, refresh, logout, удаление.
// Монтируется в server.js ДО authMiddleware — эти эндпоинты не требуют существующей сессии.
import { Router } from 'express';
import { verifyGoogleIdToken, exchangeGoogleCode } from '../services/googleIdentity.js';
import { verifyAppleIdentityToken, exchangeAppleCode } from '../services/appleIdentity.js';
import { upsertUserFromProvider, deleteUser } from '../services/users.js';
import { issueTokens, rotateRefresh, revokeRefresh, revokeAllForUser } from '../services/session.js';
import { requireUser } from '../middleware/requireUser.js';

export const authRouter = Router();

// POST /v1/auth/google  { idToken, nonce? }  — прямой id_token (устаревший)
//                    или { code, codeVerifier, redirectUri } — PKCE authorization code flow
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

// DELETE /v1/auth/account — удаление аккаунта (требование Apple). Нужен Bearer.
authRouter.delete('/v1/auth/account', requireUser, async (req, res, next) => {
  try {
    await revokeAllForUser(req.userId);
    await deleteUser(req.userId);
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});
