/**
 * Sweeper lock tests — `SET lock:<job> <id> NX PX <ttl>` (§13.2): a second
 * worker can never double-run a sweeper. Needs a real Redis (CI service;
 * locally `redis-server --maxmemory-policy noeviction`). Asserts it actually
 * ran in CI so a silent skip can't pass the gate.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { Redis } from 'ioredis'
import { acquireJobLock, releaseJobLock, withJobLock } from '../jobLock.js'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'
let redis: Redis | null = null

beforeAll(async () => {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await r.connect()
    await r.ping()
    redis = r
  } catch {
    r.disconnect()
  }
})

describe('job lock — no double-run', () => {
  it('never silently skips in CI', () => {
    if (process.env['CI']) expect(redis).not.toBeNull()
  })

  it('SET NX PX: held lock rejects a second acquisition; release is holder-only', async () => {
    if (!redis) return
    await redis.del('lock:test-sweeper')

    const holder = await acquireJobLock(redis, 'test-sweeper', 5000)
    expect(holder).not.toBeNull()
    expect(await acquireJobLock(redis, 'test-sweeper', 5000)).toBeNull()
    expect(await releaseJobLock(redis, 'test-sweeper', 'wrong-holder')).toBe(false)
    expect(await releaseJobLock(redis, 'test-sweeper', holder!)).toBe(true)
  })

  it('withJobLock: exactly one of two concurrent runs executes', async () => {
    if (!redis) return
    await redis.del('lock:test-sweeper')

    let runs = 0
    const body = async (): Promise<string> => {
      runs += 1
      await new Promise((r) => setTimeout(r, 50))
      return 'ran'
    }
    const [a, b] = await Promise.all([
      withJobLock(redis, 'test-sweeper', 5000, body),
      withJobLock(redis, 'test-sweeper', 5000, body),
    ])
    expect(runs).toBe(1)
    expect([a, b].filter((x) => x === 'ran')).toHaveLength(1)
    expect([a, b].filter((x) => x === null)).toHaveLength(1)
  })

  it('the lock key follows the D20 shape lock:<job>', async () => {
    if (!redis) return
    await redis.del('lock:shape-check')
    const holder = await acquireJobLock(redis, 'shape-check', 5000)
    expect(await redis.exists('lock:shape-check')).toBe(1)
    await releaseJobLock(redis, 'shape-check', holder!)
  })
})
