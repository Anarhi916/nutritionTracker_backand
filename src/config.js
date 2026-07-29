// Централизованная конфигурация: читает .env, задаёт дефолты, allowlist моделей.
import dotenv from 'dotenv';

dotenv.config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv,
  isProd: nodeEnv === 'production',

  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    baseUrl:
      process.env.OPENROUTER_BASE_URL ??
      'https://openrouter.ai/api/v1/chat/completions',
  },

  // Allowlist моделей — модифицированный клиент не сможет заказать дорогую модель.
  // Пулы соответствуют клиентскому APIConfig (см. ARCHITECTURE.md).
  models: {
    text: ['google/gemini-2.5-flash-lite'],
    photo: ['google/gemini-2.5-flash'],
    norms: ['google/gemini-3.6-flash', 'google/gemini-2.5-pro'],
    // объединённый allowlist для валидации входящих запросов
    allowed: [
      'google/gemini-2.5-flash-lite',
      'google/gemini-2.5-flash',
      'google/gemini-2.5-pro',
      'google/gemini-3.6-flash',
    ],
  },

  db: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/nutritiontracker',
    testUrl:
      process.env.TEST_DATABASE_URL ??
      'postgres://localhost:5432/nutritiontracker_test',
  },

  auth: {
    // 'dev' | 'prod'
    mode: process.env.AUTH_MODE ?? 'dev',
    devSecret: process.env.DEV_AUTH_SECRET ?? '',
    appleTeamId: process.env.APPLE_TEAM_ID ?? '',
    appleBundleId: process.env.APPLE_BUNDLE_ID ?? 'com.nutrition.tracker',
    googlePackageName: process.env.GOOGLE_PACKAGE_NAME ?? 'com.nutrition.tracker',
    googleProjectNumber: process.env.GOOGLE_CLOUD_PROJECT_NUMBER ?? '',
  },

  // Пользовательские аккаунты (Sign in with Apple / Google) + наша сессия (JWT).
  accounts: {
    // Секрет для подписи НАШИХ access-JWT (HS256). Обязателен в prod.
    jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-jwt-secret-change-me',
    accessTtlSec: parseInt(process.env.ACCESS_TTL_SEC ?? '900', 10),          // 15 мин
    refreshTtlSec: parseInt(process.env.REFRESH_TTL_SEC ?? '2592000', 10),    // 30 дней

    apple: {
      // aud для нативного iOS = bundle ID; для web/Android-flow = Services ID.
      bundleId: process.env.APPLE_BUNDLE_ID ?? 'com.nutrition.tracker',
      servicesId: process.env.APPLE_SERVICES_ID ?? '',
      teamId: process.env.APPLE_TEAM_ID ?? '',
      keyId: process.env.APPLE_KEY_ID ?? '',
      // Содержимое .p8 (ES256 private key). \n экранированы в .env — восстанавливаем.
      privateKey: (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      // redirect_uri для web-OAuth flow (Android): наш backend-эндпоинт.
      redirectUri: process.env.APPLE_REDIRECT_URI ?? '',
    },

    google: {
      clientIds: [
        process.env.GOOGLE_CLIENT_ID_IOS ?? '',
        process.env.GOOGLE_CLIENT_ID_ANDROID ?? '',
        process.env.GOOGLE_CLIENT_ID_WEB ?? '',
      ].filter(Boolean),
      webClientSecret: process.env.GOOGLE_CLIENT_SECRET_WEB ?? '',
    },
  },


  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10),
  },
};
