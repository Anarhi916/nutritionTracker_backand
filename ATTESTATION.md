# Аттестация: App Attest (iOS) / Play Integrity (Android)

Аттестация отвечает на вопрос **«это подлинная сборка нашего приложения на настоящем
устройстве?»** — НЕ «кто пользователь» (это делают user-JWT, см. `auth`) и НЕ «оплачено ли»
(это RevenueCat, отдельная фаза). Слои ортогональны и сосуществуют: в prod запрос к `/v1/*`
проходит `authMiddleware` (аттестация) → `requireUser` (Bearer).

## Как это устроено

### Режимы (`AUTH_MODE`)
- `dev` — сервер принимает заголовок `X-Dev-Auth: <DEV_AUTH_SECRET>`. Аттестацию нельзя
  воспроизвести на симуляторе/эмуляторе, поэтому в разработке используется общий секрет.
- `prod` — реальные App Attest (iOS) / Play Integrity (Android). Платформа берётся из
  заголовка `X-Platform: ios|android`.

Клиенты — **best-effort**: если аттестация недоступна (симулятор, не сконфигурирована,
Play-сервисы недоступны), клиент отправляет только `X-Dev-Auth`, который принимает лишь
dev-бэкенд. prod-бэкенд без валидной аттестации вернёт 401.

### iOS — Apple App Attest
1. **Enrollment (один раз на установку):** `GET`(POST) `/v1/attest/challenge` → одноразовый
   challenge; `DCAppAttestService.generateKey()` → keyId; `attestKey()` над `SHA256(challenge)`;
   `POST /v1/attest/apple/register {keyId, attestation, challenge}`. Бэкенд проверяет цепочку
   сертификатов до **закреплённого** Apple App Attestation Root CA
   (`backend/src/services/apple-app-attest-root-ca.pem`), nonce в расширении сертификата,
   App ID hash, AAGUID (prod/dev), `signCount==0`, `keyId==credentialId`; сохраняет публичный
   ключ устройства + счётчик в таблице `attest_keys`. keyId кэшируется в Keychain.
2. **Каждый запрос:** `clientData = "<random>:<epochMillis>"`, `generateAssertion()` над
   `SHA256(clientData)`; заголовки `X-Attest-KeyId` / `X-Attest-Assertion` / `X-Attest-Nonce`.
   Бэкенд проверяет ECDSA-подпись сохранённым ключом, App ID hash, свежесть (timestamp) и
   **строгий рост signCount** (анти-replay, атомарный `UPDATE ... WHERE sign_count < $1`).

Заголовки генерируются заново перед каждой отправкой, включая retry после 401-refresh
(assertion одноразовый по signCount).

### Android — Google Play Integrity
Сервер-managed keys (Standard API). На каждый защищённый запрос: клиент запрашивает свежий
integrity-токен, привязанный `requestHash = SHA256hex(nonce)`; шлёт `X-Integrity-Token`,
`X-Integrity-Nonce`, `X-Device-Id`. Бэкенд вызывает `decodeIntegrityToken` (сервис-аккаунт) и
проверяет verdict: `requestPackageName`, `requestHash == SHA256hex(nonce)` (привязка
токен↔запрос), свежесть, `appRecognitionVerdict==PLAY_RECOGNIZED`,
`deviceRecognitionVerdict ∋ MEETS_DEVICE_INTEGRITY`, опционально `appLicensingVerdict==LICENSED`,
и одноразовость токена (sha256 в `attest_used_tokens`). Стабильного device-id у Play Integrity
нет — `X-Device-Id` (ANDROID_ID) используется только для rate-limit.

---

## Что НУЖНО сделать вручную (внешние предусловия) перед включением prod

Пока НЕ сделано — аттестация остаётся выключенной (`AUTH_MODE=dev`). Ничего из списка ниже не
разворачивать на prod без явного решения.

### Apple (iOS)
1. **App Attest capability** — в Apple Developer у App ID `com.nutrition.tracker` включить
   возможность App Attest (DeviceCheck). Отдельного entitlement-файла для окружения не
   добавляем: среда (development/production) выбирается автоматически по provisioning-профилю
   (Xcode-сборка → development AAGUID, App Store/TestFlight → production).
2. **`APPLE_TEAM_ID`** — заполнить 10-символьный Team ID в `backend/.env` на сервере.
   `APPLE_BUNDLE_ID` уже = `com.nutrition.tracker`.
3. **`APPLE_ALLOW_DEV_ATTEST`** — в prod держать `false`. `true` только для отладки на
   dev-устройстве (иначе dev-attestation подделывается с любого dev-девайса).

### Google (Android)
1. **Google Cloud project** — создать/использовать проект, **привязать его в Play Console**
   (Play Console → App integrity → Integrity API → link Cloud project).
2. **Сервис-аккаунт** с доступом к Play Integrity API (роль/скоуп `playintegrity`); скачать
   JSON-ключ, положить на сервер (НЕ в git), указать путь в `GOOGLE_APPLICATION_CREDENTIALS`.
3. **`GOOGLE_CLOUD_PROJECT_NUMBER`** — номер проекта в `backend/.env`; тот же номер прописать
   клиенту через `play.integrity.cloud.project.number` в `androidApp/local.properties`
   (BuildConfig `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`).
4. **`PLAY_INTEGRITY_REQUIRE_LICENSED`** — `false` на время закрытого тестирования, `true`
   перед публичным релизом (блокирует sideload).

### Схема БД
Применить `backend/src/db/schema.sql` (идемпотентный) — добавляет `attest_keys`,
`attest_challenges`, `attest_used_tokens`.

### Тестирование
- App Attest и Play Integrity работают **только на реальных устройствах** (не симулятор/эмулятор).
- Проверить: enrollment iOS (один раз), затем защищённые запросы; Android — получение токена и
  прохождение verdict на устройстве с сертифицированными Play-сервисами.

### Активация prod (ОТЛОЖЕНО — делать отдельным осознанным шагом)
Только после всего вышеперечисленного и тестов на устройствах: сменить `AUTH_MODE=dev` →
`prod` в `backend/.env` на сервере и передеплоить. До этого момента prod остаётся на dev-секрете.
`X-Dev-Auth` (общий хардкоженный секрет в клиентах) — известный блокер, снимается этим
переключением.
