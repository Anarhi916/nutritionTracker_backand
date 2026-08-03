// requireUser — checks Authorization: Bearer <our access-JWT>, sets req.userId.
// Applied to /v1/food/* and /v1/norms ON TOP OF authMiddleware (attestation/dev-secret).
import { verifyAccess } from '../services/session.js';
import { userExists } from '../services/users.js';

export async function requireUser(req, res, next) {
  try {
    const header = req.get('Authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return res.status(401).json({ error: 'unauthorized', message: 'Нужен Authorization: Bearer' });
    }
    const userId = await verifyAccess(m[1]);
    // Token is valid by signature, but the account may have been deleted from another device.
    if (!(await userExists(userId))) {
      return res.status(401).json({ error: 'account_deleted', message: 'Аккаунт удалён' });
    }
    req.userId = userId;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: 'Недействительный или истёкший токен' });
  }
}
