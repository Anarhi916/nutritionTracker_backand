// App Attest (iOS) верификация. КАРКАС — реальная крипто-проверка включается перед
// релизом (нужны боевые устройства: аттестацию нельзя воспроизвести на симуляторе).
//
// Полный flow (при активации):
//   1. Регистрация ключа: клиент шлёт attestation object (CBOR) + keyId.
//      Валидируем: цепочку сертификатов до Apple App Attest Root CA, что nonce
//      совпадает, App ID (APPLE_TEAM_ID + APPLE_BUNDLE_ID), counter=0. Сохраняем
//      публичный ключ по keyId.
//   2. Каждый запрос: клиент шлёт assertion (подпись тела + счётчик). Проверяем
//      подпись публичным ключом, что счётчик монотонно растёт (анти-replay).
//
// Заголовки (при активации): X-Attest-KeyId, X-Attest-Assertion, X-Attest-Object (при регистрации).
// Библиотеки-кандидаты: node-app-attest / собственная реализация на основе Apple docs.
import { config } from '../config.js';

/**
 * @param {import('express').Request} req
 * @returns {Promise<{ok:boolean, deviceId?:string, reason?:string}>}
 */
export async function verifyAppAttest(req) {
  // TODO(release): реализовать верификацию attestation/assertion.
  // Сейчас prod-режим намеренно отклоняет iOS, пока крипто-проверка не активирована,
  // чтобы НЕ пропускать неаутентифицированные запросы под видом рабочей защиты.
  if (!config.auth.appleTeamId) {
    return { ok: false, reason: 'App Attest не сконфигурирован (APPLE_TEAM_ID пуст)' };
  }
  const keyId = req.get('X-Attest-KeyId');
  if (!keyId) return { ok: false, reason: 'нет X-Attest-KeyId' };
  return { ok: false, reason: 'App Attest верификация ещё не активирована (каркас)' };
}
