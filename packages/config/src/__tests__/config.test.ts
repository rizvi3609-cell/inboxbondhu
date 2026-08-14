import { describe, expect, it } from 'vitest'
import { parseEnv, loadSeedConfig } from '../index.js'

const VALID: Record<string, string> = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/inboxbondhu',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'x'.repeat(32),
  CHANNEL_TOKEN_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  PII_HASH_PEPPER: 'pepper-pepper-pepper',
  META_APP_ID: 'app-id',
  META_APP_SECRET: 'app-secret',
  META_VERIFY_TOKEN: 'verify-token',
  LLM_API_KEY: 'sk-test',
}

describe('config loader — fail-fast with one clear line', () => {
  it('parses a valid env and applies documented defaults', () => {
    const r = parseEnv(VALID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.PORT).toBe(4000)
    expect(r.config.AI_TOTAL_DEADLINE_MS).toBe(15000)
    expect(r.config.MAX_CONCURRENT_SESSIONS).toBe(5)
    expect(r.config.MAX_DISCOUNT_PERCENT).toBe(50)
    expect(r.config.DEFAULT_TIMEZONE).toBe('Asia/Dhaka')
    expect(r.config.REDIS_MAXMEMORY_POLICY).toBe('noeviction')
    expect(r.config.META_API_VERSION).toBe('v21.0')
  })

  it('a missing required var fails with ONE clear line naming the key', () => {
    const { MONGODB_URI: _omit, ...rest } = VALID
    const r = parseEnv(rest)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toMatch(/^FATAL config: MONGODB_URI/)
    expect(r.message.split('\n')).toHaveLength(1) // one line, literally
  })

  it('rejects a short JWT_SECRET', () => {
    const r = parseEnv({ ...VALID, JWT_SECRET: 'short' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('JWT_SECRET')
  })

  it('rejects a CHANNEL_TOKEN_MASTER_KEY that is not 32 bytes', () => {
    const r = parseEnv({ ...VALID, CHANNEL_TOKEN_MASTER_KEY: Buffer.alloc(16).toString('base64') })
    expect(r.ok).toBe(false)
  })

  it('rejects REDIS_MAXMEMORY_POLICY other than noeviction (INV-11, layer 1)', () => {
    const r = parseEnv({ ...VALID, REDIS_MAXMEMORY_POLICY: 'allkeys-lru' })
    expect(r.ok).toBe(false)
  })

  it('rejects MAX_DISCOUNT_PERCENT above 50 (money-loss control)', () => {
    const r = parseEnv({ ...VALID, MAX_DISCOUNT_PERCENT: '60' })
    expect(r.ok).toBe(false)
  })

  it('coerces numeric strings', () => {
    const r = parseEnv({ ...VALID, PORT: '8080', LLM_TIMEOUT_MS: '5000' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.config.PORT).toBe(8080)
    expect(r.config.LLM_TIMEOUT_MS).toBe(5000)
  })

  it('loadSeedConfig needs only MONGODB_URI and defaults it', () => {
    expect(loadSeedConfig({}).MONGODB_URI).toBe('mongodb://127.0.0.1:27017/inboxbondhu')
    expect(loadSeedConfig({ MONGODB_URI: 'mongodb://x/db' }).MONGODB_URI).toBe('mongodb://x/db')
  })
})
