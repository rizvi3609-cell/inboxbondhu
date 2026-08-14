/**
 * Boot chain tests — prompt.md §4 assertions in order:
 * Mongo reachable → Redis reachable → noeviction → indexes exist.
 * Requires a real Redis on REDIS_URL (CI provides one; locally:
 * `redis-server --maxmemory-policy noeviction`). Skips politely if absent —
 * but ASSERTS it ran in CI so a silent skip can't pass the gate there.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { assertNoeviction, createRedis, healthCheck } from '../db/client.js'
import { assertIndexes, createIndexes } from '../db/indexes.js'
import { startDb, stopDb } from './setupDb.js'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'
// A second instance deliberately misconfigured with allkeys-lru (test rig only).
const BAD_REDIS_URL = process.env['BAD_REDIS_URL'] ?? 'redis://127.0.0.1:6380'

async function redisAvailable(url: string): Promise<boolean> {
  const r = createRedis(url)
  try {
    await r.connect()
    await r.ping()
    return true
  } catch {
    return false
  } finally {
    r.disconnect()
  }
}

let haveRedis = false
let haveBadRedis = false

beforeAll(async () => {
  await startDb()
  haveRedis = await redisAvailable(REDIS_URL)
  haveBadRedis = await redisAvailable(BAD_REDIS_URL)
}, 300_000)

afterAll(async () => {
  await stopDb()
})

describe('boot assertion chain', () => {
  it('never silently skips in CI', () => {
    if (process.env['CI']) expect(haveRedis).toBe(true)
  })

  it('accepts a Redis running noeviction (INV-11)', async () => {
    if (!haveRedis) return
    const redis = createRedis(REDIS_URL)
    await redis.connect()
    await expect(assertNoeviction(redis)).resolves.toBeUndefined()
    redis.disconnect()
  })

  it('REFUSES to boot against allkeys-lru with one clear line', async () => {
    if (!haveBadRedis) return
    const redis = createRedis(BAD_REDIS_URL)
    await redis.connect()
    await expect(assertNoeviction(redis)).rejects.toThrow(/noeviction.*INV-11/s)
    redis.disconnect()
  })

  it('healthCheck reports mongo+redis up against real dependencies', async () => {
    if (!haveRedis) return
    const redis = createRedis(REDIS_URL)
    await redis.connect()
    const report = await healthCheck({ mongoose, redis })
    expect(report).toEqual({ mongo: true, redis: true })
    redis.disconnect()
  })

  it('index assertion passes after createIndexes (boot step 5)', async () => {
    await createIndexes()
    expect(await assertIndexes()).toEqual([])
  })

})
