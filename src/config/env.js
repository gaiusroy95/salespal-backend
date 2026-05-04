const dotenv = require('dotenv');
dotenv.config();

// ─── Build DATABASE_URL from individual components if not provided ────────────
// Typical: set DATABASE_URL (Render Postgres, Neon, Supabase, etc.).
// Optional: DB_HOST starting with "/" is treated as a Unix socket (e.g. legacy Cloud SQL on Cloud Run).
if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_HOST, DB_PORT = '5432', DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  const encodedPassword = encodeURIComponent(DB_PASSWORD || '');
  if (DB_HOST.startsWith('/')) {
    // Unix socket (Cloud SQL)
    process.env.DATABASE_URL = `postgresql://${DB_USER}:${encodedPassword}@/${DB_NAME}?host=${DB_HOST}`;
  } else {
    process.env.DATABASE_URL = `postgresql://${DB_USER}:${encodedPassword}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  }
}

const { z } = require('zod');

function parseCsvList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore invalid JSON, keep fallback
  }
  return fallback;
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME required'),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_ACCESS_SECRET: z.string().min(10).optional(),
  JWT_REFRESH_SECRET: z.string().min(10),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_TTL: z.coerce.number().default(604800),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional().default(''),
  GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: z.string().optional().default(''),
  GCP_PROJECT_ID: z.string().optional().default(''),
  GCP_LOCATION: z.string().optional().default('us-central1'),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  DATA_RETENTION_DAYS: z.coerce.number().default(365),
  DISABLE_SUBSCRIPTIONS: z.string().optional().default('false'),
  GEMINI_MARKETING_MODEL: z.string().optional().default('gemini-2.5-flash'),
  /** Optional AI video provider (e.g. replicate). */
  AI_VIDEO_PROVIDER: z.string().optional().default('none'),
  /** Ordered providers for auto mode, e.g. "replicate,google-veo". */
  AI_VIDEO_PROVIDER_ORDER: z.string().optional().default('replicate,google-veo'),
  /** Optional single fallback provider if primary fails. */
  AI_VIDEO_FALLBACK_PROVIDER: z.string().optional().default(''),
  /** Provider API key/token for AI video generation. */
  AI_VIDEO_API_KEY: z.string().optional().default(''),
  /** Provider model version/id (Replicate version hash, etc.). */
  AI_VIDEO_MODEL_VERSION: z.string().optional().default(''),
  /** Provider-specific model version for Replicate. */
  AI_VIDEO_REPLICATE_MODEL_VERSION: z.string().optional().default(''),
  /** Provider-specific Veo model id, e.g. veo-3.1-generate-001. */
  AI_VIDEO_VEO_MODEL_ID: z.string().optional().default(''),
  /** Optional GCS output prefix for Veo, e.g. gs://bucket/videos/ */
  AI_VIDEO_VEO_STORAGE_URI: z.string().optional().default(''),
  /** Max polling time for async AI video jobs in ms. Set <=0 for near-infinite wait. */
  AI_VIDEO_POLL_TIMEOUT_MS: z.coerce.number().default(0),
  /** Max concurrently running backend video jobs per API instance. */
  AI_VIDEO_JOB_MAX_CONCURRENCY: z.coerce.number().default(2),
  /** Max total stitched length when combining multiple Veo clips (seconds). */
  AI_VIDEO_MAX_STITCH_SECONDS: z.coerce.number().default(180),
  /** Path to ffmpeg binary for stitching Veo clips (default looks up PATH). */
  AI_VIDEO_FFMPEG_PATH: z.string().optional().default('ffmpeg'),
  PORT: z.string().default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  FRONTEND_URL: z.string().optional().default('https://salespal.vercel.app'),
  FRONTEND_URLS: z.string().optional().default(''),
  CORS_ORIGINS: z.string().default('*'),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_REDIRECT_URIS: z.string().optional().default(''),
  FACEBOOK_REDIRECT_URI: z.string().optional(),
  FACEBOOK_REDIRECT_URIS: z.string().optional().default(''),
  INSTAGRAM_REDIRECT_URI: z.string().optional(),
  INSTAGRAM_REDIRECT_URIS: z.string().optional().default(''),
  LINKEDIN_REDIRECT_URI: z.string().optional(),
  LINKEDIN_REDIRECT_URIS: z.string().optional().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  /** Per client IP per window; keep generous for SPAs (many parallel API calls). */
  RATE_LIMIT_MAX: z.coerce.number().default(400),
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  MAX_FILE_SIZE: z.coerce.number().default(10485760),
  LOG_LEVEL: z.string().default('info'),
  TATA_CALL_ENABLED: z.string().optional().default('false'),
  TATA_CALL_API_URL: z.string().optional(),
  TATA_CALL_ENDPOINT_PATH: z.string().optional().default('/v1/click_to_call'),
  TATA_CALL_API_KEY: z.string().optional(),
  TATA_CALL_AUTH_SCHEME: z.string().optional().default('Bearer'),
  TATA_CALL_FROM_NUMBER: z.string().optional().default(''),
  TATA_CALL_STATUS_WEBHOOK_URL: z.string().optional().default(''),
  TATA_CALL_TIMEOUT_MS: z.coerce.number().default(10000),
  TATA_CALL_RING_TIMEOUT_MS: z.coerce.number().default(3500),
  TATA_CALL_ASYNC: z.coerce.number().default(1),
  TATA_CALL_GET_CALL_ID: z.coerce.number().default(1),
  TATA_CALL_EXTRA_HEADERS: z.string().optional().default('{}'),
  TATA_CALL_STATIC_PAYLOAD: z.string().optional().default('{}'),
  TATA_WEBHOOK_TOKEN: z.string().optional().default(''),
  TATA_WEBHOOK_TOKEN_HEADER: z.string().optional().default('x-tata-webhook-token'),
  WHATSAPP_ENABLED: z.string().optional().default('false'),
  WHATSAPP_API_URL: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_TIMEOUT_MS: z.coerce.number().default(10000),
  /** Approved Meta template name for project catalogue dispatch (workflow A). */
  WHATSAPP_TEMPLATE_PROJECT_CATALOG: z.string().optional().default(''),
  WHATSAPP_TEMPLATE_LANGUAGE_CODE: z.string().optional().default('en'),
  /** Voice / SMS attribution line, e.g. “MOUNTT GROUP”. */
  WHATSAPP_VOICE_BRAND_NAME: z.string().optional().default('SalesPal'),
  /** Optional E164 for owner alerts / digests via WhatsApp. */
  OWNER_WHATSAPP_MSISDN: z.string().optional().default(''),
  /** Fallback IANA zone for parsing “tomorrow 10 AM” when lead has none. */
  LEAD_SCHEDULE_DEFAULT_TZ: z.string().optional().default(''),
  CRON_INGEST_SECRET: z.string().optional().default(''),
  /** Lightweight JSON scan for calling scripts before dial (campaign gate). */
  CALL_SCRIPT_AI_COMPLIANCE: z.string().optional().default('true'),
  /** Transcript-only safeguard pass on voice turns (no audio kill-switch). */
  VOICE_TRANSCRIPT_SAFEGUARDS: z.string().optional().default('false'),
  /** Sarvam Bulbul TTS (Indian languages) — use with Vertex/Gemini for voice brain. */
  SARVAM_API_SUBSCRIPTION_KEY: z.string().optional().default(''),
  SARVAM_TTS_URL: z.string().optional().default(''),
  SARVAM_TTS_MODEL: z.string().optional().default('bulbul:v3'),
  SARVAM_TTS_SPEAKER: z.string().optional().default(''),
  SARVAM_TARGET_LANGUAGE_CODE: z.string().optional().default(''),
  SARVAM_TTS_PACE: z.string().optional().default(''),
  /** auto (Sarvam if key set) | sarvam | browser */
  VOICE_TTS_PROVIDER: z.string().optional().default('auto'),
  SARVAM_STT_URL: z.string().optional().default(''),
  /** saaras:v3 (recommended) | saarika:v2.5 */
  SARVAM_STT_MODEL: z.string().optional().default('saaras:v3'),
  /** Mode when using saaras:v3: transcribe | translate | verbatim | translit | codemix */
  SARVAM_STT_MODE: z.string().optional().default('codemix'),
  /** auto (Sarvam if key set) | sarvam | browser (Web Speech API) */
  VOICE_STT_PROVIDER: z.string().optional().default('auto'),
});

const parsed = envSchema.parse(process.env);

const env = {
  ...parsed,
  isProduction: parsed.NODE_ENV === 'production',
  isDevelopment: parsed.NODE_ENV === 'development',
  logLevel: parsed.LOG_LEVEL,
  corsOrigins: (() => {
    const raw = String(parsed.CORS_ORIGINS || '').trim();
    if (!raw || raw === '*') return '*';
    return parseCsvList(raw);
  })(),
  frontendOrigins: (() => {
    const out = new Set();
    const add = (value) => {
      if (!value) return;
      const s = String(value).trim();
      if (!s) return;
      try {
        out.add(new URL(s).origin);
      } catch {
        out.add(s.replace(/\/$/, ''));
      }
    };
    add(parsed.FRONTEND_URL);
    parseCsvList(parsed.FRONTEND_URLS).forEach(add);
    if (parsed.CORS_ORIGINS !== '*') parseCsvList(parsed.CORS_ORIGINS).forEach(add);
    return Array.from(out);
  })(),
  bcryptSaltRounds: parsed.BCRYPT_ROUNDS,
  jwt: {
    accessSecret: parsed.JWT_ACCESS_SECRET || parsed.JWT_SECRET || parsed.JWT_REFRESH_SECRET,
    refreshSecret: parsed.JWT_REFRESH_SECRET,
    accessTTL: parsed.JWT_EXPIRES_IN,
    refreshTTL: parsed.JWT_REFRESH_TTL,
  },
  rateLimit: {
    windowMs: parsed.RATE_LIMIT_WINDOW_MS,
    max: parsed.RATE_LIMIT_MAX,
  },
  google: {
    clientId: parsed.GOOGLE_CLIENT_ID || '',
    redirectUri: parsed.GOOGLE_REDIRECT_URI || '',
    redirectUris: parseCsvList(parsed.GOOGLE_REDIRECT_URIS),
    serviceAccountJson: parsed.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    serviceAccountJsonBase64: parsed.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 || '',
  },
  oauth: {
    facebookRedirectUri: parsed.FACEBOOK_REDIRECT_URI || '',
    facebookRedirectUris: parseCsvList(parsed.FACEBOOK_REDIRECT_URIS),
    instagramRedirectUri: parsed.INSTAGRAM_REDIRECT_URI || '',
    instagramRedirectUris: parseCsvList(parsed.INSTAGRAM_REDIRECT_URIS),
    linkedinRedirectUri: parsed.LINKEDIN_REDIRECT_URI || '',
    linkedinRedirectUris: parseCsvList(parsed.LINKEDIN_REDIRECT_URIS),
  },
  ai: {
    geminiApiKey: parsed.GOOGLE_GENERATIVE_AI_API_KEY || '',
    model: parsed.GEMINI_MARKETING_MODEL || 'gemini-2.5-flash',
    videoProvider: String(parsed.AI_VIDEO_PROVIDER || 'none').toLowerCase(),
    videoProviderOrder: parseCsvList(parsed.AI_VIDEO_PROVIDER_ORDER).map((p) => p.toLowerCase()),
    videoFallbackProvider: String(parsed.AI_VIDEO_FALLBACK_PROVIDER || '').toLowerCase(),
    videoApiKey: parsed.AI_VIDEO_API_KEY || '',
    videoModelVersion: parsed.AI_VIDEO_MODEL_VERSION || '',
    videoReplicateModelVersion: parsed.AI_VIDEO_REPLICATE_MODEL_VERSION || '',
    videoVeoModelId: parsed.AI_VIDEO_VEO_MODEL_ID || '',
    videoVeoStorageUri: parsed.AI_VIDEO_VEO_STORAGE_URI || '',
    videoPollTimeoutMs: parsed.AI_VIDEO_POLL_TIMEOUT_MS,
    videoJobMaxConcurrency: parsed.AI_VIDEO_JOB_MAX_CONCURRENCY,
    videoMaxStitchSeconds: parsed.AI_VIDEO_MAX_STITCH_SECONDS,
    videoFfmpegPath: parsed.AI_VIDEO_FFMPEG_PATH || 'ffmpeg',
  },
  upload: {
    maxFileSize: parsed.MAX_FILE_SIZE,
  },
  security: {
    razorpayWebhookSecret: parsed.RAZORPAY_WEBHOOK_SECRET || '',
    dataRetentionDays: parsed.DATA_RETENTION_DAYS,
  },
  subscriptions: {
    disabled: String(parsed.DISABLE_SUBSCRIPTIONS || 'false').toLowerCase() === 'true',
  },
  integrations: {
    sarvamApiKey: String(parsed.SARVAM_API_SUBSCRIPTION_KEY || '').trim(),
    sarvamTtsUrl: String(parsed.SARVAM_TTS_URL || '').trim(),
    sarvamModel: String(parsed.SARVAM_TTS_MODEL || 'bulbul:v3').trim(),
    sarvamSpeaker: String(parsed.SARVAM_TTS_SPEAKER || '').trim(),
    sarvamDefaultLanguage: String(parsed.SARVAM_TARGET_LANGUAGE_CODE || '').trim(),
    sarvamPace:
      parsed.SARVAM_TTS_PACE === '' ? NaN : Number(parsed.SARVAM_TTS_PACE || Number.NaN),
    voiceTtsProvider: String(parsed.VOICE_TTS_PROVIDER || 'auto').trim().toLowerCase(),
    sarvamSttUrl: String(parsed.SARVAM_STT_URL || '').trim(),
    sarvamSttModel: String(parsed.SARVAM_STT_MODEL || 'saaras:v3').trim(),
    sarvamSttMode: String(parsed.SARVAM_STT_MODE || 'codemix').trim(),
    voiceSttProvider: String(parsed.VOICE_STT_PROVIDER || 'auto').trim().toLowerCase(),
  },
  telephony: {
    provider: 'tata',
    enabled: String(parsed.TATA_CALL_ENABLED || 'false').toLowerCase() === 'true',
    apiUrl: parsed.TATA_CALL_API_URL || '',
    endpointPath: parsed.TATA_CALL_ENDPOINT_PATH || '/v1/click_to_call',
    apiKey: parsed.TATA_CALL_API_KEY || '',
    authScheme: parsed.TATA_CALL_AUTH_SCHEME || 'Bearer',
    fromNumber: parsed.TATA_CALL_FROM_NUMBER || '',
    statusWebhookUrl: parsed.TATA_CALL_STATUS_WEBHOOK_URL || '',
    timeoutMs: parsed.TATA_CALL_TIMEOUT_MS,
    ringTimeoutMs: parsed.TATA_CALL_RING_TIMEOUT_MS,
    asyncMode: parsed.TATA_CALL_ASYNC,
    getCallId: parsed.TATA_CALL_GET_CALL_ID,
    extraHeaders: parseJsonObject(parsed.TATA_CALL_EXTRA_HEADERS, {}),
    staticPayload: parseJsonObject(parsed.TATA_CALL_STATIC_PAYLOAD, {}),
    webhookToken: parsed.TATA_WEBHOOK_TOKEN || '',
    webhookTokenHeader: parsed.TATA_WEBHOOK_TOKEN_HEADER || 'x-tata-webhook-token',
  },
  whatsapp: {
    enabled: String(parsed.WHATSAPP_ENABLED || 'false').toLowerCase() === 'true',
    apiUrl:
      parsed.WHATSAPP_API_URL ||
      (parsed.WHATSAPP_PHONE_NUMBER_ID
        ? `https://graph.facebook.com/v21.0/${parsed.WHATSAPP_PHONE_NUMBER_ID}/messages`
        : ''),
    accessToken: parsed.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: parsed.WHATSAPP_PHONE_NUMBER_ID || '',
    timeoutMs: parsed.WHATSAPP_TIMEOUT_MS,
    catalogueTemplateName: String(parsed.WHATSAPP_TEMPLATE_PROJECT_CATALOG || '').trim(),
    catalogueTemplateLang: String(parsed.WHATSAPP_TEMPLATE_LANGUAGE_CODE || 'en').trim() || 'en',
    voiceBrandName: String(parsed.WHATSAPP_VOICE_BRAND_NAME || 'SalesPal').trim() || 'SalesPal',
  },
  cronIngestSecret: String(parsed.CRON_INGEST_SECRET || '').trim(),
  ownerWhatsappMsisdn: String(parsed.OWNER_WHATSAPP_MSISDN || '').replace(/\D/g, ''),
  leadScheduleDefaultTz: String(parsed.LEAD_SCHEDULE_DEFAULT_TZ || '').trim(),
  callScriptCompliance: String(parsed.CALL_SCRIPT_AI_COMPLIANCE || 'true').toLowerCase() === 'true',
  voiceTranscriptSafeguards: String(parsed.VOICE_TRANSCRIPT_SAFEGUARDS || 'false').toLowerCase() === 'true',
  GCP_PROJECT_ID: parsed.GCP_PROJECT_ID || '',
  GCP_LOCATION: parsed.GCP_LOCATION || 'us-central1',
};

module.exports = env;
