/**
 * packages/config — THE only place that reads process.env (agent.md §4.1).
 * Zod-validated at boot; any missing/malformed key refuses to start with ONE
 * clear line (prompt.md §4). Everything else imports the typed result.
 */
import { z } from 'zod'

const durationRe = /^\d+(ms|s|m|h|d)$/

export const EnvSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://localhost:4000'),

  // Data
  MONGODB_URI: z.string().min(1).refine((v) => v.startsWith('mongodb'), 'must be a mongodb:// or mongodb+srv:// URI'),
  REDIS_URL: z.string().min(1).refine((v) => v.startsWith('redis'), 'must be a redis:// or rediss:// URL'),
  /** Documented expectation; the REAL control is CONFIG GET at boot (INV-11). */
  REDIS_MAXMEMORY_POLICY: z.literal('noeviction').default('noeviction'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be ≥ 32 chars (256-bit)'),
  JWT_SECRET_PREVIOUS: z.string().default(''),
  ACCESS_TOKEN_TTL: z.string().regex(durationRe).default('15m'),
  REFRESH_TOKEN_TTL: z.string().regex(durationRe).default('30d'),
  MAX_CONCURRENT_SESSIONS: z.coerce.number().int().min(1).default(5),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),

  // Encryption
  CHANNEL_TOKEN_MASTER_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes base64'),
  CHANNEL_TOKEN_KEY_VERSION: z.coerce.number().int().min(1).default(1),
  PII_HASH_PEPPER: z.string().min(16),

  // Meta
  META_APP_ID: z.string().min(1),
  META_APP_SECRET: z.string().min(1),
  META_VERIFY_TOKEN: z.string().min(1),
  META_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v21.0'),
  META_MESSAGING_WINDOW_HOURS: z.coerce.number().int().min(1).default(24),

  // LLM
  LLM_PROVIDER: z.enum(['openai', 'gemini']).default('openai'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('gpt-4o-mini'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(9000),
  AI_TOTAL_DEADLINE_MS: z.coerce.number().int().min(1000).default(15000),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  AI_DAILY_COST_CAP_MINOR: z.coerce.number().int().min(0).default(20000),
  AI_PLATFORM_DAILY_CAP_MINOR: z.coerce.number().int().min(0).default(500000),
  PROMPT_VERSION: z.string().default('v1'),

  // Storage / Email
  SPACES_ENDPOINT: z.string().default(''),
  SPACES_BUCKET: z.string().default(''),
  SPACES_KEY: z.string().default(''),
  SPACES_SECRET: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('InboxBondhu <no-reply@inboxbondhu.me>'),

  // Observability
  DD_API_KEY: z.string().default(''),
  DD_SITE: z.string().default('datadoghq.com'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Business rules
  DEFAULT_TIMEZONE: z.literal('Asia/Dhaka').default('Asia/Dhaka'),
  MAX_DISCOUNT_PERCENT: z.coerce.number().int().min(0).max(50).default(50),
  ABANDONED_ORDER_HOURS: z.coerce.number().int().min(1).default(24),
  STUCK_MESSAGE_SECONDS: z.coerce.number().int().min(1).default(60),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  MAX_PENDING_INVITES: z.coerce.number().int().min(1).default(20),
  CSV_MAX_ROWS: z.coerce.number().int().min(1).default(5000),
})

export type AppConfig = z.infer<typeof EnvSchema>

/**
 * Parse an env dict. Returns a Result-style outcome so tests can assert the
 * failure without killing the test process.
 */
export function parseEnv(
  env: Record<string, string | undefined> = process.env,
): { ok: true; config: AppConfig } | { ok: false; message: string } {
  const result = EnvSchema.safeParse(env)
  if (result.success) return { ok: true, config: result.data }
  const first = result.error.issues[0]
  const all = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
  return {
    ok: false,
    // ONE clear line — the boot contract.
    message: `FATAL config: ${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'invalid'} (${all})`,
  }
}

let cached: AppConfig | null = null

/**
 * Load and cache the config, or exit(1) with one clear line. Call once at
 * boot from apps/api and apps/worker. Never read process.env anywhere else.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  if (cached) return cached
  const parsed = parseEnv(env)
  if (!parsed.ok) {
    console.error(parsed.message)
    process.exit(1)
  }
  cached = parsed.config
  return cached
}

/** Test-only: reset the cache. */
export function resetConfigForTests(): void {
  cached = null
}

// ─── Narrow loaders for tools that must not demand the full env ─────────────

const SeedEnvSchema = z.object({
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/inboxbondhu'),
})

/**
 * Seed/script config: only MONGODB_URI, with a local default. Exists so the
 * seed script does not read process.env directly (agent.md §4.1) yet also
 * does not demand LLM keys just to insert fixtures.
 */
export function loadSeedConfig(
  env: Record<string, string | undefined> = process.env,
): z.infer<typeof SeedEnvSchema> {
  return SeedEnvSchema.parse(env)
}
