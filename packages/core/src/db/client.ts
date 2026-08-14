/**
 * db/client — Mongo + Redis connections, health checks, and the boot
 * assertion chain (prompt.md §4): env parses → Mongo reachable → Redis
 * reachable → maxmemory-policy noeviction → indexes exist → queues registered.
 * Any failure exits non-zero with ONE clear line.
 */
import mongoose from 'mongoose'
import { Redis } from 'ioredis'
import { assertIndexes, createIndexes } from './indexes.js'

export interface DbClients {
  mongoose: typeof mongoose
  redis: Redis
}

export async function connectMongo(uri: string): Promise<typeof mongoose> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
  return mongoose
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
    enableOfflineQueue: false,
  })
}

/** INV-11 hard gate: under allkeys-lru Redis silently drops queued BullMQ work. */
export async function assertNoeviction(redis: Redis): Promise<void> {
  const reply = (await redis.config('GET', 'maxmemory-policy')) as [string, string]
  const policy = reply[1]
  if (policy !== 'noeviction') {
    throw new Error(
      `FATAL boot: Redis maxmemory-policy is "${policy}", must be "noeviction" — ` +
        `queued jobs would be silently discarded (INV-11)`,
    )
  }
}

export interface HealthReport {
  mongo: boolean
  redis: boolean
}

export async function healthCheck(clients: DbClients): Promise<HealthReport> {
  // §14.1: /readyz must answer PROMPTLY when a dependency is down — the LB
  // needs the 503 in milliseconds, not after the driver's 30 s server
  // selection. readyState !== 1 short-circuits; a live ping gets a 2 s cap.
  const withTimeout = <T>(p: Promise<T>, fallback: T, ms = 2000): Promise<T> =>
    Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())])

  const mongoPing =
    clients.mongoose.connection.readyState !== 1
      ? Promise.resolve(false)
      : withTimeout(
          clients.mongoose.connection.db
            ?.admin()
            .ping()
            .then(() => true)
            .catch(() => false) ?? Promise.resolve(false),
          false,
        )
  const [mongo, redis] = await Promise.all([
    mongoPing,
    withTimeout(
      clients.redis
        .ping()
        .then((r) => r === 'PONG')
        .catch(() => false),
      false,
    ),
  ])
  return { mongo, redis }
}

/**
 * The full fail-fast boot, in the §4 order. `ensureIndexes: true` creates
 * missing indexes in dev/test; production runs `autoIndex: false` semantics —
 * indexes come from migrations and boot only ASSERTS them.
 */
export async function bootDataLayer(opts: {
  mongoUri: string
  redisUrl: string
  ensureIndexes: boolean
}): Promise<DbClients> {
  // 2. Mongo reachable (1 = env, already parsed by caller)
  const m = await connectMongo(opts.mongoUri).catch((err: Error) => {
    throw new Error(`FATAL boot: MongoDB unreachable at startup — ${err.message}`)
  })

  // 3. Redis reachable
  const redis = createRedis(opts.redisUrl)
  await redis.connect().catch((err: Error) => {
    throw new Error(`FATAL boot: Redis unreachable at startup — ${err.message}`)
  })

  // 4. noeviction
  await assertNoeviction(redis)

  // 5. indexes
  if (opts.ensureIndexes) await createIndexes()
  const missing = await assertIndexes()
  if (missing.length > 0) {
    const detail = missing.map((f) => `${f.collection}[${f.missing.join(',')}]`).join(' ')
    throw new Error(`FATAL boot: required indexes missing — ${detail}`)
  }

  return { mongoose: m, redis }
}

export async function shutdownDataLayer(clients: DbClients): Promise<void> {
  await clients.mongoose.disconnect().catch(() => undefined)
  clients.redis.disconnect()
}
