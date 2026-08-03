// Centralized configuration: reads .env, sets defaults, model allowlist.
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

  // Model allowlist — a modified client cannot request an expensive model.
  // Pools match the client APIConfig (see ARCHITECTURE.md).
  models: {
    text: ['google/gemini-2.5-flash-lite'],
    photo: ['google/gemini-2.5-flash'],
    norms: ['google/gemini-3.6-flash', 'google/gemini-2.5-pro'],
    // combined allowlist for validating incoming requests
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

  // User accounts (Sign in with Apple / Google) + our session (JWT).
  accounts: {
    // Secret for signing OUR access JWTs (HS256). Required in prod.
    jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-jwt-secret-change-me',
    accessTtlSec: parseInt(process.env.ACCESS_TTL_SEC ?? '900', 10),          // 15 min
    refreshTtlSec: parseInt(process.env.REFRESH_TTL_SEC ?? '2592000', 10),    // 30 days

    apple: {
      // aud for native iOS = bundle ID; for web/Android flow = Services ID.
      bundleId: process.env.APPLE_BUNDLE_ID ?? 'com.nutrition.tracker',
      servicesId: process.env.APPLE_SERVICES_ID ?? '',
      teamId: process.env.APPLE_TEAM_ID ?? '',
      keyId: process.env.APPLE_KEY_ID ?? '',
      // Contents of .p8 (ES256 private key). \n is escaped in .env — restore it.
      privateKey: (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
      // redirect_uri for web OAuth flow (Android): our backend endpoint.
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
