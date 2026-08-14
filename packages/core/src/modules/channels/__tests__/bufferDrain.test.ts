/**
 * Redis buffer + drainer tests (needs a real Redis; asserts it ran in CI):
 * - Mongo down + Redis up → event lands in wh:buffer, 200 path
 * - drainRedisBuffer replays into webhookEvents; replay is dedupe-safe (I48)
 * - the wh:{dedupeKey} SETNX fast gate short-circuits duplicates
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mongoose from 'mongoose'
import { Redis } from 'ioredis'
import { WebhookEvent } from '../../../db/index.js'
import { BUFFER_KEY, drainRedisBuffer, intakeWebhook } from '../webhookIntake.js'
import { dropData, startDb, stopDb } from '../../../__tests__/setupDb.js'

const APP_SECRET = 'buffer-secret'
const REQ = '0'.repeat(26)
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'

let redis: Redis | null = null
let journalDir: string

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
}
function metaBody(mid: string): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'page',
    entry: [{ id: 'pageB1', messaging: [{ sender: { id: 'psid-9' }, message: { mid, text: 'hello' } }] }],
  }))
}

beforeAll(async () => {
  await startDb()
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await r.connect()
    await r.ping()
    redis = r
  } catch {
    r.disconnect()
  }
}, 300_000)

afterAll(async () => {
  redis?.disconnect()
  await stopDb()
})

beforeEach(async () => {
  await dropData()
  journalDir = mkdtempSync(join(tmpdir(), 'ib-buf-'))
  if (redis) {
    await redis.del(BUFFER_KEY)
    const keys = await redis.keys('wh:*')
    if (keys.length > 0) await redis.del(...keys)
  }
})

describe('Redis fast gate + outage buffer', () => {
  it('never silently skips in CI', () => {
    if (process.env['CI']) expect(redis).not.toBeNull()
  })

  it('SETNX gate: second delivery within 24 h is skipped before touching Mongo', async () => {
    if (!redis) return
    const body = metaBody('mid.gate1')
    const deps = { redis, journalDir, enqueue: async () => undefined }
    const first = await intakeWebhook(body, sign(body), APP_SECRET, REQ, deps)
    const second = await intakeWebhook(body, sign(body), APP_SECRET, REQ, deps)
    expect(first.accepted).toBe(1)
    expect(second).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(await redis.exists('wh:facebook:pageB1:mid.gate1')).toBe(1)
    const ttl = await redis.ttl('wh:facebook:pageB1:mid.gate1')
    expect(ttl).toBeGreaterThan(86_000)
    expect(ttl).toBeLessThanOrEqual(86_400) // the 24 h gate — deliberately < 7 d retention
  })

  it('Mongo down + Redis up → buffered to wh:buffer, accepted', async () => {
    if (!redis) return
    await mongoose.disconnect()
    try {
      const body = metaBody('mid.buf1')
      const result = await intakeWebhook(body, sign(body), APP_SECRET, REQ, {
        redis, journalDir, enqueue: async () => undefined,
      })
      expect(result.accepted).toBe(1)
      expect(result.buffered).toBe('redis')
      expect(await redis.llen(BUFFER_KEY)).toBe(1)
    } finally {
      await startDb()
    }
  })

  it('drainRedisBuffer replays the buffer once Mongo returns; replay is dedupe-safe', async () => {
    if (!redis) return
    // Buffer two events while Mongo is "down".
    await mongoose.disconnect()
    const bodies = [metaBody('mid.drain1'), metaBody('mid.drain2')]
    try {
      for (const body of bodies) {
        await intakeWebhook(body, sign(body), APP_SECRET, REQ, { redis, journalDir, enqueue: async () => undefined })
      }
    } finally {
      await startDb()
    }
    expect(await redis.llen(BUFFER_KEY)).toBe(2)

    const enqueued: string[] = []
    const first = await drainRedisBuffer(redis, async (j) => void enqueued.push(j.dedupeKey))
    expect(first).toEqual({ drained: 2, deduped: 0 })
    expect(await redis.llen(BUFFER_KEY)).toBe(0)
    expect(await WebhookEvent.countDocuments({ processStatus: 'pending' }).exec()).toBe(2)
    expect(enqueued.sort()).toEqual(['facebook:pageB1:mid.drain1', 'facebook:pageB1:mid.drain2'])

    // A crashed drainer that re-pushed the same rows: replay is safe (I48).
    await redis.rpush(BUFFER_KEY, JSON.stringify({
      dedupeKey: 'facebook:pageB1:mid.drain1', provider: 'facebook', externalPageId: 'pageB1',
      entry: { sender: { id: 'psid-9' }, message: { mid: 'mid.drain1', text: 'hello' } },
      receivedAt: new Date().toISOString(), requestId: REQ,
    }))
    const second = await drainRedisBuffer(redis, async () => undefined)
    expect(second).toEqual({ drained: 0, deduped: 1 })
    expect(await WebhookEvent.countDocuments({ dedupeKey: 'facebook:pageB1:mid.drain1' }).exec()).toBe(1)
  })
})
