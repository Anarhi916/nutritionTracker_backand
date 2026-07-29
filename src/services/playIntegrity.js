// Play Integrity (Android) верификация. КАРКАС — реальная проверка включается перед
// релизом (нужен Play-подписанный APK + Google Cloud credentials).
//
// Полный flow (при активации):
//   1. Клиент запрашивает Integrity Token у Play Integrity API (с nonce от сервера).
//   2. Клиент шлёт токен на сервер (X-Integrity-Token).
//   3. Сервер расшифровывает/верифицирует токен через Google Play Integrity API
//      (google-auth-library + Play Integrity decode endpoint или локальная расшифровка
//      сервер-ключом). Проверяем:
//        - appRecognitionVerdict == PLAY_RECOGNIZED
//        - packageName == GOOGLE_PACKAGE_NAME
//        - nonce совпадает (анти-replay)
//        - (опц.) deviceRecognitionVerdict / MEETS_DEVICE_INTEGRITY
//
// Заголовки (при активации): X-Integrity-Token, X-Integrity-Nonce.
import { config } from '../config.js';

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyPlayIntegrity(req) {
  // TODO(release): реализовать верификацию Integrity Token.
  // Сейчас prod-режим намеренно отклоняет Android, пока проверка не активирована.
  if (!config.auth.googleProjectNumber) {
    return { ok: false, reason: 'Play Integrity не сконфигурирован (GOOGLE_CLOUD_PROJECT_NUMBER пуст)' };
  }
  const token = req.get('X-Integrity-Token');
  if (!token) return { ok: false, reason: 'нет X-Integrity-Token' };
  return { ok: false, reason: 'Play Integrity верификация ещё не активирована (каркас)' };
}
