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
const isProd = nodeEnv === 'production';

// A secret that MUST be present in production but may fall back to a well-known
// dev default otherwise. Refuses to start in prod if the env var is missing, so
// we can never silently ship a forgeable-token / open-secret configuration.
function prodRequiredSecret(name, devFallback) {
  const v = process.env[name];
  if (v) return v;
  if (isProd) {
    throw new Error(`В production обязательна переменная окружения: ${name}`);
  }
  return devFallback;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv,
  isProd,

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
    // 'dev' | 'prod'. In production AUTH_MODE must be set EXPLICITLY to 'dev' or 'prod':
    // we refuse to silently default to the insecure shared-secret 'dev' path when the var
    // is missing. An explicit AUTH_MODE=dev is honored (App Attest / Play Integrity is a
    // deliberately deferred phase — attestation is orthogonal to the account-JWT layer).
    mode: (() => {
      const m = process.env.AUTH_MODE;
      if (isProd) {
        if (m !== 'dev' && m !== 'prod') {
          throw new Error('В production AUTH_MODE должен быть явно задан: "dev" или "prod"');
        }
        return m;
      }
      return m ?? 'dev';
    })(),
    devSecret: process.env.DEV_AUTH_SECRET ?? '',
    appleTeamId: process.env.APPLE_TEAM_ID ?? '',
    appleBundleId: process.env.APPLE_BUNDLE_ID ?? 'com.nutrition.tracker',
    googlePackageName: process.env.GOOGLE_PACKAGE_NAME ?? 'uk.nutritiontracker.app',
    googleProjectNumber: process.env.GOOGLE_CLOUD_PROJECT_NUMBER ?? '',

    // --- App Attest / Play Integrity tuning (all have safe defaults) ---
    // Enrollment challenge lifetime (single-use, short-lived).
    attestChallengeTtlSec: parseInt(process.env.ATTEST_CHALLENGE_TTL_SEC ?? '300', 10),
    // Allowed clock skew for the per-request assertion/token freshness check.
    attestFreshnessSec: parseInt(process.env.ATTEST_FRESHNESS_SEC ?? '300', 10),
    // Accept the App Attest *development* AAGUID ("appattestdevelop"). MUST be false in
    // production — a development attestation is forgeable from any Xcode-run build.
    // Defaults to false in prod, true otherwise (so a dev backend can test with Xcode builds).
    appleAllowDevAttest:
      (process.env.APPLE_ALLOW_DEV_ATTEST ?? (isProd ? 'false' : 'true')) === 'true',
    // Path to the Google service-account JSON used to call decodeIntegrityToken.
    // If empty, google-auth-library falls back to GOOGLE_APPLICATION_CREDENTIALS / ADC.
    googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
    // Require accountDetails.appLicensingVerdict == LICENSED (blocks sideloaded/internal
    // testers). Off by default so internal testing tracks work; turn on for public release.
    playIntegrityRequireLicensed:
      (process.env.PLAY_INTEGRITY_REQUIRE_LICENSED ?? 'false') === 'true',
  },

  // User accounts (Sign in with Apple / Google) + our session (JWT).
  accounts: {
    // Secret for signing OUR access JWTs (HS256). Required in prod.
    jwtSecret: prodRequiredSecret('JWT_SECRET', 'dev-insecure-jwt-secret-change-me'),
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
