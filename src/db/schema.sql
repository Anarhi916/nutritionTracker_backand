-- Схема БД NutritionTracker backend.
-- Идемпотентна: можно запускать повторно (IF NOT EXISTS).
-- См. ARCHITECTURE.md — self-host USDA + кросс-юзерный кэш.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- USDA FDC (self-host копия): Foundation + SR Legacy + FNDDS.
-- Branded НЕ импортируем (штрихкоды идут через OpenFoodFacts).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS foods (
  fdc_id      INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  data_type   TEXT
);

CREATE TABLE IF NOT EXISTS food_nutrients (
  fdc_id      INTEGER NOT NULL REFERENCES foods(fdc_id) ON DELETE CASCADE,
  nutrient_id INTEGER NOT NULL,
  value       DOUBLE PRECISION,
  PRIMARY KEY (fdc_id, nutrient_id)
);

-- Trigram-индекс для полнотекстового поиска по описанию (ILIKE / similarity).
CREATE INDEX IF NOT EXISTS idx_foods_desc_trgm
  ON foods USING gin (description gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Кросс-юзерный кэш server-generated нутриентов.
-- Ключ = normalizeKey(food_name_en) из шага identify (см. ARCHITECTURE.md).
-- Пишем СЮДА только результаты текстового пайплайна (доверенные, server-generated).
-- Штрихкод (данные от клиента) и фото — НЕ пишем.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS food_cache (
  key_en     TEXT PRIMARY KEY,           -- нормализованный английский ключ
  nutrients  JSONB NOT NULL,             -- 34 нутриента на 100 г
  source     TEXT,                       -- 'usda' | 'ai'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Пользовательские аккаунты (Sign in with Apple / Google).
-- Только идентификация; данные (профиль/дневник) пока локальны на устройстве.
-- Один и тот же человек через Apple И Google → один ряд (оба *_sub на строке).
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub     TEXT UNIQUE,              -- Apple 'sub' (стабильный идентификатор)
  google_sub    TEXT UNIQUE,             -- Google 'sub'
  email         TEXT,                     -- может быть null / Apple private relay
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- Refresh-токены: храним ТОЛЬКО sha256-хэш (не сырой токен). Ротация при refresh.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,           -- sha256(hex) refresh-токена
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);


-- ---------------------------------------------------------------------------
-- Синхронизация данных пользователя между устройствами.
-- Стратегия: server-as-source-of-truth, last-write-wins по updated_at.
-- Все таблицы имеют updated_at + deleted_at (soft delete синхронизируется).
-- Профиль/нормы — 1 ряд на юзера (PK = user_id). Дневник/сохранённые — много рядов
-- с идемпотентным client_id (uuid, генерится на клиенте) → нет дублей при повторном push.
-- Клиент шлёт/принимает updated_at в epoch-миллисекундах; тут храним TIMESTAMPTZ.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_profiles (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  gender      TEXT,
  age         INTEGER,
  weight_kg   DOUBLE PRECISION,
  height_cm   DOUBLE PRECISION,
  goals_text  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_norms (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nutrients   JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sync_food_entries (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL,             -- uuid, сгенерён на клиенте (идемпотентность)
  date          TEXT NOT NULL,             -- "yyyy-MM-dd"
  food_name     TEXT NOT NULL,
  food_name_en  TEXT NOT NULL DEFAULT '',
  weight_grams  DOUBLE PRECISION NOT NULL,
  nutrients_json TEXT NOT NULL,            -- храним как есть (клиент шлёт строку)
  source        TEXT NOT NULL DEFAULT 'manual',
  from_cache    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS sync_food_cache (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_normalized   TEXT NOT NULL,          -- натуральный идемпотентный ключ
  key_original     TEXT NOT NULL,
  key_en           TEXT NOT NULL DEFAULT '',
  key_en_normalized TEXT NOT NULL DEFAULT '',
  nutrients_json   TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  PRIMARY KEY (user_id, key_normalized)
);

-- Миграция для существующих БД: добавить server_updated_at ДО создания индексов по ней.
ALTER TABLE sync_profiles     ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sync_norms        ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sync_food_entries ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE sync_food_cache   ADD COLUMN IF NOT EXISTS server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_sync_entries_pull
  ON sync_food_entries(user_id, server_updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_cache_pull
  ON sync_food_cache(user_id, server_updated_at);

-- Commit-order-safe delta cursor (see sync.js). server_updated_at is now()=transaction
-- START time, which is NOT consistent with commit-visibility order: a push that BEGAN
-- earlier but COMMITS later carries an earlier stamp, so a concurrent pull could advance
-- its cursor past those rows and strand them forever. pg_current_xact_id() (xid8, no
-- wraparound) is assigned per push transaction; the pull watermark is the snapshot xmin,
-- below which every transaction has settled — so nothing can ever be back-filled under it.
-- Existing rows get server_xid=0 (< any xmin) → delivered on the first pull after migration.
ALTER TABLE sync_profiles     ADD COLUMN IF NOT EXISTS server_xid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sync_norms        ADD COLUMN IF NOT EXISTS server_xid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sync_food_entries ADD COLUMN IF NOT EXISTS server_xid BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sync_food_cache   ADD COLUMN IF NOT EXISTS server_xid BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sync_profiles_xid ON sync_profiles(user_id, server_xid);
CREATE INDEX IF NOT EXISTS idx_sync_norms_xid    ON sync_norms(user_id, server_xid);
CREATE INDEX IF NOT EXISTS idx_sync_entries_xid  ON sync_food_entries(user_id, server_xid);
CREATE INDEX IF NOT EXISTS idx_sync_cache_xid    ON sync_food_cache(user_id, server_xid);
