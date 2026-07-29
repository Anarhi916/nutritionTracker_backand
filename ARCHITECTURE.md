# NutritionTracker Backend — Архитектура и зафиксированные решения

> Опорный документ. Все решения ниже согласованы с владельцем проекта в июле 2026.
> При реализации СВЕРЯТЬСЯ с этим файлом. Не менять поведение без явного решения.

## Зачем этот бэкенд существует

Оба клиента (iOS `ifoneApp/`, Android `androidApp/`) сейчас ходят к трём внешним API
напрямую, с ключами, зашитыми в бинарник:

- **OpenRouter** (`POST /api/v1/chat/completions`, Bearer-ключ) — платный AI. Ключ
  извлекается из .ipa/.apk → любой может жечь наши деньги. **Главный блокер.**
- **USDA FDC** (`GET /fdc/v1/foods/search`, ключ в query, hardcoded) — бесплатный,
  лимит **1000 req/час на IP**.
- **OpenFoodFacts** (`GET /api/v2/product/{barcode}.json`, без ключа) — лимит по IP.

Бэкенд решает: (1) прячет ключ OpenRouter на сервере, (2) отдаёт USDA-поиск из своей
Postgres-копии (снимает лимит 1000/час навсегда), (3) даёт кросс-юзерный кэш нутриентов,
(4) пускает только подлинные сборки через App Attest / Play Integrity.

**Wire-формат запросов/ответов на iOS и Android идентичен** — один бэкенд обслуживает обе
платформы. Вся многошаговая логика уже реализована в `NutritionRepository` на обеих
платформах — это **порт пайплайна на сервер**, а не переизобретение.

## Роль бэкенда: ОРКЕСТРАТОР, не passthrough

Вся цепочка `analyzeFoodText` (identify → USDA-поиск → выбор → верификация → обогащение)
переезжает на сервер. Клиент делает **один** вызов на действие и получает готовый продукт.
Выгода: (1) промпты/выбор моделей скрыты от клиента, (2) кросс-юзерный кэш, (3) один
round-trip вместо 3–7.

## Стек и принципы

- **Node.js на чистом JavaScript** (без TypeScript), Express, `pg`, `undici` для forward.
- **Stateless** (состояние в Postgres) — с 1-го дня, под будущее горизонтальное масштабирование.
- **Отдельная тестовая БД** — с 1-го дня (данные USDA восстановимы из архива).
- `express.json({ limit: '6mb' })` — из-за base64-фото.
- Хостинг: пока только локально.

---

## Границы доверия и кэш (ГЛАВНЫЙ ПРИНЦИП)

Кэш ключуется по **`keyEn`** — нормализованному АНГЛИЙСКОМУ имени. Английский язык-независим:
запросы «гречка» / «Buchweizen» / «sarrasin» после identify дают один `keyEn=buckwheat` →
одна запись кэша. **Дорогой USDA-пайплайн выполняется один раз на весь мир.**

- Кэш хранит **только `keyEn` + нутриенты (на 100 г)**. Локализованного имени в кэше НЕТ.
- **Отображаемое имя — забота клиента:** продукт сохраняется у юзера с тем именем, что он
  ввёл. Бэкенд оперирует только `keyEn` + числами.
- **В общий кэш пишем ТОЛЬКО server-generated данные** (текстовый пайплайн). Данные от
  клиента (OFF по штрихкоду) НЕ пишем — защита от отравления кэша.
- **Фото не кэшируем** — оценка по фото менее точна, чем USDA.

### Источник `keyEn` (ВАЖНО — не перепутать при порте)

Ключ = `normalizeKey(food_name_en)` из шага **identify**, как в текущем проверенном коде
обеих платформ. `generateUsdaSearchQueries` (2-3 поисковых фразы для USDA) ключа НЕ касается.

Эти шаги возвращают разное НАМЕРЕННО:
- `food_name_en` = «что это за продукт» → одно каноничное значение → стабильный ключ.
- USDA-запросы = «как это найти в USDA» → несколько вариантов, недетерминированы →
  фрагментировали бы кэш. Генерируются только ПОСЛЕ промаха кэша, живут внутри USDA-поиска.

`normalizeKey` = lowercased + слова отсортированы по алфавиту + схлопнуты пробелы
(порядок слов не важен). Источник: iOS `DatabaseManager.normalizeKey`.

---

## Потоки

### 1. Текст — `POST /v1/food/analyze` (полная оркестрация)

Вход от клиента: сырой запрос (любой язык) + **вес уже спарсен локально** (у клиента есть
многоязычный `WeightParser` с oz/lb) + код языка UI.

Сервер:
1. **AI identify (ВСЕГДА)** → `keyEn` + `food_name_en`. Неизбежен: именно он вычисляет ключ.
2. Проверка `keyEn` в БД `food_cache`:
   - **hit** → вернуть нутриенты из БД (пайплайн пропущен).
   - **miss** → полный пайплайн по локальной USDA: генерация запроса (AI) → поиск в Postgres →
     выбор кандидата (AI) → верификация (AI) → обогащение → **запись в `food_cache` по `keyEn`** → вернуть.
3. Ответ клиенту: нутриенты (на 100 г) + `food_name_en` / `keyEn`.

Клиент: пересчитывает на вес, сохраняет в локальные «сохранённые продукты» с ИМЕНЕМ, КОТОРОЕ
ВВЁЛ ЮЗЕР; локальный кэш ключуется по `foodNameEn` → кросс-язычно и на устройстве.

**Условия enrich-шагов на miss (портируем ТОЧНО, НЕ «всегда»):**

| Шаг | Условие срабатывания |
|---|---|
| **micro-fill** (`buildMicroFillPrompt`) | `iodine < 0.01` — почти всегда (USDA не даёт йод). Просит у AI ВСЮ микро-панель (24 нутриента); мерджит назад ТОЛЬКО нулевые поля (USDA-данные в приоритете). |
| **batch-nutrients** (`buildBatchNutrientPrompt`) | ТОЛЬКО если USDA не нашёл (`nutrientsPer100g == nil`): составное блюдо >5 значимых слов, нет кандидатов, или AI отверг все picks. Нутриенты целиком от AI. |
| **dairy-ГОСТ** (`correctDairyMacrosWithAI`) | ТОЛЬКО молочка с явным `%` жирности (keyword молоко/творог/сметана/… + regex `%`, и НЕ твёрдый сыр). USDA ищется с отрезанным `%`, макросы перезаписываются по ГОСТ. |
| **fat-details** (`enrichFatDetailsIfNeeded`) | `fat>0 && mono==0 && poly==0`. Сначала USDA, потом AI. |

**ИСПРАВЛЕНИЕ асимметрии (зафиксировано):** в текущем клиенте fat-details для свежего
USDA-совпадения НЕ вызывается (только для уже-кэшированных, добор на повторном запросе). На
сервере вызываем **СРАЗУ на miss**, до записи в кэш → одна запись кэша = полные нутриенты,
«второго захода» нет.

Типичный USDA-хит («buckwheat cooked»): фичат identify + query-gen + pick + verify + micro-fill
(+ fat-details если применимо). batch/dairy — пропускаются.

### 2. Штрихкод — `POST /v1/food/enrich` (клиент → OFF, сервер обогащает)

OFF-запрос по штрихкоду делает **сам клиент** (свой IP → лимит не схлопывается; ключа нет —
прятать нечего). Клиент шлёт результат OFF на сервер → сервер дообогащает недостающие
микронутриенты и разбивку жиров (AI) → возвращает. **В общий кэш НЕ пишем** (данные от клиента).

### 3. Фото — `POST /v1/food/photo` (чистый AI, БЕЗ USDA)

Портируем 1-в-1, НЕ унифицируем с текстовым пайплайном.

- Распознавание: `identifyAndAnalyzeFoodFromPhoto` на **`gemini-2.5-flash`** (photoModels) →
  сразу `food_name + food_name_en + weight + все нутриенты`. USDA не участвует (фото = готовое
  блюдо/порция, в USDA как строку не найти; USDA индексирует ингредиенты).
- **Имя НЕ изменено:** переиспользуются нутриенты от фото + micro-enrich + пересчёт на вес.
  Повторного запроса нутриентов НЕТ.
- **Имя изменено:** `analyzeSingleDish(новое имя, useCache:false)` на **`gemini-2.5-flash-lite`**
  (textModels) — чистый AI, без USDA, фото отбрасывается, путь чисто текстовый по новому имени.
  Модель понижается flash→flash-lite — существующее поведение, сохраняем.
- **Не кэшируем.**

### 4. Нормы — `POST /v1/norms`

AI-расчёт суточных норм (платный AI → ключ прятать). Вход: пол/возраст/вес/рост/цели.
Выход: 34 нутриента. Без кэша (индивидуально).

### 4b. Блюдо — `POST /v1/food/dish` (для фото со сменой имени)

`analyzeSingleDish` — целое блюдо через AI, БЕЗ USDA, БЕЗ кэша. Вход `{dishName}` →
`{foodNameEn, nutrientsPer100g}`. Клиент вызывает при правке имени после фото.

### 4c. БАД — `POST /v1/food/supplement`

Клиент сам ходит в OFF (имя+порция), шлёт `{name, servingSize, barcode}`. Сервер считает
нутриенты НА ПОРЦИЮ через AI (`getSupplementNutrientsFromAI`). Выход
`{name, servingSize, nutrientsPerServing}`. БЕЗ кэша (данные от клиента).

### 5. `GET /health` — liveness.

> Все AI-вызовы физически идут через один внутренний модуль `openrouter.js`
> (forward + allowlist моделей + retry). Эндпоинты — оркестраторы над ним и локальной USDA.

**Контракты эндпоинтов (для клиентского слоя):**
| Метод | Вход | Выход |
|---|---|---|
| `POST /v1/food/analyze` | `{items:[{name,grams}], uiLang, useCache?}` | `{results:[{foodName,foodNameEn,weightGrams,nutrientsPer100g,fromCache}]}` |
| `POST /v1/food/enrich` | `{name, nutrientsPer100g}` (OFF от клиента) | `{name, nutrientsPer100g}` |
| `POST /v1/food/photo` | `{imageBase64, uiLang}` | `{foodName,foodNameEn,weightGrams,nutrientsPer100g}` |
| `POST /v1/food/dish` | `{dishName}` | `{foodNameEn, nutrientsPer100g}` |
| `POST /v1/food/supplement` | `{name, servingSize, barcode}` | `{name, servingSize, nutrientsPerServing}` |
| `POST /v1/norms` | `{gender,age,weight,height,goals}` | `{norms:{34 поля}}` |
Все `/v1/*` требуют `X-Dev-Auth` (dev). Нутриенты — на 100г (кроме supplement — на порцию); клиент масштабирует.

---

## Модели AI (OpenRouter)

| Пул | Модель | Использование |
|---|---|---|
| textModels | `google/gemini-2.5-flash-lite` | identify, USDA query-gen/pick/verify, batch-nutrients, micro-fill, single-dish |
| photoModels | `google/gemini-2.5-flash` | распознавание по фото |
| normsModels | `google/gemini-2.5-pro`, `google/gemini-2.5-flash` | расчёт суточных норм |

**Allowlist на сервере:** `flash-lite`, `flash`, `pro`. Модель вне allowlist → отклонение
(модифицированный клиент не закажет дорогую модель).

---

## Структура кода

```
backend/
  package.json
  .env.example          # OPENROUTER_API_KEY, DB_URL, APPLE_*, GOOGLE_*, AUTH_MODE, DEV_AUTH_SECRET
  src/
    server.js           # bootstrap Express, middleware, роуты
    config.js           # env, allowlist моделей, флаги
    middleware/
      auth.js           # App Attest / Play Integrity, dev-bypass
      rateLimit.js      # per-device лимит
    routes/
      food.js           # /v1/food/analyze, /enrich, /photo
      norms.js          # /v1/norms
      health.js
    services/
      openrouter.js     # forward + retry(429/5xx) + allowlist моделей
      pipeline.js       # ПОРТ analyzeFoodText: identify→USDA→pick→verify→enrich
      usdaSearch.js     # полнотекстовый/trigram поиск в Postgres
      cache.js          # чтение/запись food_cache по keyEn (нормализация)
      appAttest.js      # верификация Apple attestation/assertion
      playIntegrity.js  # верификация Google integrity token
      prompts.js        # все промпты (порт из NutritionRepository)
    db/
      pool.js           # pg Pool
      schema.sql        # foods, food_nutrients, food_cache, индексы
  scripts/
    import-usda.js      # bulk-импорт FDC CSV → Postgres
```

---

## Self-host USDA + кэш (Postgres)

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE foods (
  fdc_id INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  data_type TEXT
);
CREATE TABLE food_nutrients (
  fdc_id INTEGER REFERENCES foods(fdc_id),
  nutrient_id INTEGER,
  value DOUBLE PRECISION,
  PRIMARY KEY (fdc_id, nutrient_id)
);
CREATE INDEX idx_foods_desc_trgm ON foods USING gin (description gin_trgm_ops);

-- кросс-юзерный кэш server-generated нутриентов
CREATE TABLE food_cache (
  key_en TEXT PRIMARY KEY,          -- нормализованный английский ключ
  nutrients JSONB NOT NULL,         -- 34 нутриента на 100 г
  source TEXT,                      -- 'usda' | 'ai'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Метаданные нутриентов (`nutrientName/number/unitName`) — статической мапой в коде по
`nutrient_id` (клиенту важны `nutrientId` + `value`).

**Импорт** (`scripts/import-usda.js`): вручную скачать FDC Full Download —
**Foundation + SR Legacy + FNDDS** (Branded НЕ тянем — штрихкоды через OFF, 3 GB шума).
`food.csv`→`foods`, `food_nutrient.csv`→`food_nutrients` (фильтр нужных ID), COPY/батч.
Обновление раз в полгода (апр/дек).

### 34 нутриент-ID USDA FDC (из клиентского кода)

```
Макросы:  ENERGY 1008, PROTEIN 1003, FAT 1004, SAT_FAT 1258, MONO_FAT 1292,
          POLY_FAT 1293, CHOLESTEROL 1253, CARBS 1005, FIBER 1079
Витамины: A 1106, B1 1165, B2 1166, B3 1167, B5 1170, B6 1175, B7 1176,
          B9 1177, B12 1178, C 1162, D 1114, E 1109, K 1185
Минералы: Ca 1087, Fe 1089, Mg 1090, P 1091, K 1092, Na 1093, Zn 1095,
          Cu 1098, Mn 1101, Se 1103, IODINE 1100
```

Часто отсутствуют в USDA (→ дозаполняются micro-fill): **йод (1100), биотин B7 (1176),
пантотенка B5 (1170), витамин D (1114)**, часто витамин K, селен, B12 для растит.

`buildNutrientsFromUsda` (порт): Branded-implausibility guard, коррекция US-фортификации муки
(B1×0.17, B2×0.10, B3×0.22, B9×0.17, iron×0.26 для мучного), Atwater sanity check
(`4P + 9F + 4C > 1.3 × calories` → reject → fallthrough к AI).

---

## Auth: App Attest / Play Integrity (с dev-bypass)

`auth.js` по `AUTH_MODE`:
- **`dev`** (локально/тесты): принимает `X-Dev-Auth: <DEV_AUTH_SECRET>`. Нужен, т.к.
  аттестацию нельзя воспроизвести на симуляторе/эмуляторе.
- **`prod`**:
  - iOS (`appAttest.js`): валидация attestation (цепочка серт. Apple, App ID, nonce) при
    регистрации ключа; assertion (подпись+счётчик) на каждый запрос. Заголовки `X-Attest-*`.
  - Android (`playIntegrity.js`): верификация Integrity Token (`appRecognitionVerdict =
    PLAY_RECOGNIZED`, package, nonce).

**Rate-limit per-device** (`rateLimit.js`): базово в памяти на старте (не-stateless-исключение
до Redis; отметить).

> Attestation отвечает «подлинная ли это наша сборка?», НЕ «оплачено ли». Привязка к подписке —
> фаза RevenueCat (следующая).

---

## Изменения на клиентах (шаг рефакторинга)

Клиент из «делателя пайплайна» становится «тонким»: один вызов на действие. Многошаговая
логика в `NutritionRepository` сворачивается.

**iOS (`ifoneApp/NutritionTracker/`):**
- `Services/APIConfig.swift`: base URL → прокси; удалить `openRouterApiKey`, hardcoded
  `usdaApiKey`, загрузку из `Config.plist`. OFF-URL остаётся (штрихкод на клиенте).
- `Services/NetworkService.swift`: методы под `/v1/food/*`, `/v1/norms`; убрать
  `Authorization: Bearer`; добавить auth-заголовок.
- `Services/NutritionRepository.swift`: свернуть `analyzeFoodText` в один вызов; сохранить
  локальный кэш (`FoodCache.keyEnNormalized`), пересчёт на вес, сохранённые продукты.
  USDA/pick/verify/enrich + промпты удалить.
- Новый `Services/AppAttestService.swift`: `DCAppAttestService`.
- `Config.plist`: удалить ключи; **отозвать и перевыпустить** OpenRouter-ключ.

**Android (`androidApp/`):**
- `data/api/ApiClient.kt`: base URL → прокси; лишние Retrofit-клиенты убрать.
- вызовы под `/v1/food/*`, `/v1/norms`; OkHttp-interceptor с auth-заголовком.
- `data/repository/NutritionRepository.kt`: тот же сворачивающий рефакторинг.
- `build.gradle.kts` + `local.properties`: удалить `openrouter.api.key` и `gemini.api.key`.
- Новый `data/api/PlayIntegrityService.kt`.
- Удалить мёртвые `GeminiApiService.kt` / `GeminiModels.kt` и USDA-интерфейс.

**Что на клиенте ОСТАЁТСЯ:** локальный кэш (по `keyEnNormalized`), «сохранённые продукты» с
введённым именем, `WeightParser`, пересчёт на граммы, OFF-запрос по штрихкоду, вся i18n/UI.

---

## На будущее (НЕ сейчас)

- Проверка активной подписки (фаза RevenueCat).
- 2-й уровень кэша (по сырому вводу, до identify) — аддитивно, если данные покажут частые
  дословные повторы.
- Гибридный OFF-кэш на бэке.
- Blue-green деплой, 2 отдельные VPS, Redis для stateless rate-limit.

---

## Статус реализации (обновлять по ходу)

- [x] Задача 1 — этот документ + memory.
- [x] Задача 2 — каркас backend (Express, /health, config, pool, .env.example).
- [x] Задача 3 — USDA self-host: schema.sql + import-usda.js + импорт данных.
      Postgres 16 (brew), базы nutritiontracker + _test. Импортировано: 13694 foods
      (SR Legacy 7793 + FNDDS 5432 + Foundation 469), 386971 food_nutrients.
      ВАЖНО: FNDDS/survey ссылается на нутриенты по nutrient_nbr (208), не по FDC id (1008)
      — резолвим через resolveNutrientId (db/nutrients.js). Йод есть только у 42 продуктов.
- [x] Задача 4 — usdaSearch.js (trigram-поиск, сборка UsdaSearchResponse).
      Алгоритм: SQL-предфильтр (стем-токены ILIKE + trigram) → скоринг в JS (matchRatio,
      fullMatchBonus, позиция главного слова, coverage, state-сигнал raw/cooked,
      dish/variant-штрафы, синонимы oatmeal→oats). Валидация на 61-кейсовом наборе (сгенерён
      workflow): top-1 93.4%, top-5 ~97%. Оставшиеся «провалы» — в основном артефакты строгих
      регексов теста (flank steak, blade chops правильны). Финальный выбор из топ-25 делает AI
      в пайплайне (задача 6), поэтому идеальный top-1 не критичен. Скрипты: test-search.js,
      eval-search.js, testset.json. Формат ответа сверен с клиентским UsdaSearchResponse
      (camelCase, foods/totalHits/fdcId/foodNutrients/nutrientId/...).
- [x] Задача 5 — openrouter.js + prompts.js (порт промптов).
      openrouter.js: callOpenRouter (allowlist-валидация модели, Bearer с сервера, fetch),
      callOpenRouterWithRetry (2 retry на 429/5xx, перебор моделей пула). Проверено:
      чужая модель→400, нет ключа→500.
      prompts.js: ДОСЛОВНЫЙ порт 13 промптов из iOS (identify, usda-queries, pick, verify,
      batch, micro-fill, enrich-micros-single, fat-details, single-dish, dairy-ГОСТ, photo,
      norms) + хелперы (extractJSON, nutrientDataFromMap, fillMissingMicros, buildNutrientsFromUsda
      с Atwater/фортификацией муки/Branded-guard, sanitizeNormUnits, extractFatPercent,
      isDairyWithFatPercent, stripFatPercent). Промпты извлечены workflow'ом дословно из
      NutritionRepository.swift. db/nutrients.js +NUTRIENT_ID константы. Проверено на реальных
      данных: buckwheat→макросы+Atwater, bread→коррекция B1, dairy-детекция, единицы норм.
- [x] Задача 6 — pipeline.js + cache.js + POST /v1/food/analyze.
      cache.js: normalizeKey (сорт. слов, как iOS), findInCache/saveToCache по keyEn (UPSERT).
      pipeline.js: полный порт analyzeFoodText (identify→кэш по keyEn→USDA loop с
      generateUsdaSearchQueries/pick[2 попытки]/verify→buildNutrientsFromUsda→batch→micro-fill→
      single-dish→dairy-ГОСТ). Серверные отличия: кэш ТОЛЬКО по keyEn; fat-details СРАЗУ на miss
      (фикс асимметрии); ответ = нутриенты на 100г + вес (клиент масштабирует). Вес парсит клиент
      → сервер получает items[{name,grams}]+uiLang. food.js: POST /v1/food/analyze.
      ВЕРИФИЦИРОВАНО end-to-end с реальным ключом: гречка→MISS полный пайплайн 4.4с (buckwheat,
      cal=92 из USDA, iodine=3.3 micro-fill, mono=0.188 fat-details), запись в food_cache;
      повтор→cache-hit 0.6с (fromCache:true, пайплайн пропущен). Кросс-язычность работает
      (Buchweizen→buckwheat), но недетерминизм identify даёт вариации keyEn — принятый компромисс.
- [x] Задача 7 — /v1/food/enrich, /v1/food/photo, /v1/norms.
      pipeline.js +enrichMicros (single), analyzePhoto (photo-модель, base64 image_url, 422 если
      не JSON/не еда), enrichBarcode (нулевые макросы→analyzeSingleDish, затем enrichMicros+
      enrichFatDetails, БЕЗ записи в общий кэш). norms.js: calculateNorms (normsModels +
      sanitizeNormUnits). Роуты: food.js +/enrich +/photo; norms.js +/v1/norms. server.js подключил.
      ВЕРИФИЦИРОВАНО: norms male 30/80/180 → cal=2760, единицы ОК (copper 0.9mg, selenium 55mcg,
      iodine 150); enrich Milk 3.2% → OFF-макросы сохранены + AI дозаполнил (calcium=125, iodine=37,
      mono=0.628), кэш 2→2 (граница доверия соблюдена!); photo на не-еде → 422; валидация всех → 400.
- [x] Задача 8 — auth middleware (dev-bypass, rate-limit).
      middleware/auth.js: dev → X-Dev-Auth == DEV_AUTH_SECRET; prod → по X-Platform (ios→appAttest,
      android→playIntegrity). appAttest.js/playIntegrity.js — КАРКАСЫ (реальная крипто-верификация
      = TODO перед релизом, нужны боевые устройства + Apple/Google SDK; prod намеренно отклоняет,
      пока не активировано — не пропускает неаутентифицированное). middleware/rateLimit.js:
      per-device скользящее окно (in-memory — единственное не-stateless место, →Redis при масштабе),
      Retry-After на 429. server.js: /v1/* за authMiddleware→rateLimitMiddleware; /health без auth.
      ВЕРИФИЦИРОВАНО: /health→200; /v1/* без/неверный X-Dev-Auth→401; верный→pass; лимит 3 → запросы
      1-3 pass, 4-5→429.
- [x] Задача 9 — рефакторинг клиентов (iOS→Android) + docs/CLIENT_ARCHITECTURE.md.
      iOS: APIConfig/NetworkService/NutritionRepository свёрнуты (~1464→290 строк), ключи убраны,
      ATS NSAllowsLocalNetworking, BUILD SUCCEEDED, текст+нормы верифицированы вживую (симулятор).
      Android: BackendApiService+ApiClient+BuildConfig+network_security_config (10.0.2.2),
      NutritionRepository 2507→~430 строк, удалены OpenRouter/USDA/Gemini сервисы+модели+ключи,
      BUILD SUCCESSFUL, текст верифицирован вживую (POST /food/analyze platform=android, buckwheat
      343 kcal, эмулятор Pixel_6). Бэкенд получил +2 эндпоинта: /v1/food/dish + /v1/food/supplement.
      Штрихкод/фото/БАД — инфраструктура готова и проверена curl, UI с камерой не проверен (нет
      камеры на симуляторе/эмуляторе). docs/CLIENT_ARCHITECTURE.md создан. Отзыв OpenRouter-ключа —
      по решению владельца пока НЕ делаем.
