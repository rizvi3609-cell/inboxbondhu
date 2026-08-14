/**
 * Sweeper lock — prompt.md §13.2: every sweeper takes a Redis lock
 * `SET lock:<job> <id> NX PX <ttl>` so a future second worker cannot
 * double-run it. Written in Phase 0's job scaffold, as instructed —
 * the nine cron sweepers (Phase 8) all run through withJobLock().
 */
import type { Redis } from 'ioredis'
import { ulid } from '@inboxbondhu/core'

export async function acquireJobLock(
  redis: Redis,
  job: string,
  ttlMs: number,
): Promise<string | null> {
  const holder = ulid()
  const key = `lock:${job}` // D20 key shape
  const reply = await redis.set(key, holder, 'PX', ttlMs, 'NX')
  return reply === 'OK' ? holder : null
}

/** Release only if we still hold it — never delete another worker's lock. */
export async function releaseJobLock(redis: Redis, job: string, holder: string): Promise<boolean> {
  const script = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    else
      return 0
    end`
  const result = (await redis.eval(script, 1, `lock:${job}`, holder)) as number
  return result === 1
}

/**
 * Run `fn` under the job lock; skip silently (returns null) when another
 * worker holds it. TTL must exceed the job's worst-case runtime.
 */
export async function withJobLock<T>(
  redis: Redis,
  job: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const holder = await acquireJobLock(redis, job, ttlMs)
  if (holder === null) return null
  try {
    return await fn()
  } finally {
    await releaseJobLock(redis, job, holder)
  }
}
