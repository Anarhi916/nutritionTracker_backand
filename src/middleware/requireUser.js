// requireUser — проверяет Authorization: Bearer <наш access-JWT>, ставит req.userId.
// Накладывается на /v1/food/* и /v1/norms ПОВЕРХ authMiddleware (attestation/dev-secret).
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
    // Токен валиден по подписи, но аккаунт мог быть удалён с другого устройства.
    if (!(await userExists(userId))) {
      return res.status(401).json({ error: 'account_deleted', message: 'Аккаунт удалён' });
    }
    req.userId = userId;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized', message: 'Недействительный или истёкший токен' });
  }
}
