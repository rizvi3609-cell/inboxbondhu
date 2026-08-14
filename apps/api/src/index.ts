/**
 * apps/api bootstrap — fail-fast boot per prompt.md §4, graceful shutdown on
 * SIGTERM: stop accepting, drain in-flight, close connections.
 */
import type { Server } from 'node:http'
import { loadConfig } from '@inboxbondhu/config'
import { createLogger } from '@inboxbondhu/logger'
import { bootDataLayer, shutdownDataLayer, type DbClients } from '@inboxbondhu/core'
import { createApp } from './app.js'

// Build version is baked at package level; env access lives ONLY in
// packages/config (agent.md §4.1 — our own lint rule enforces this).
const VERSION = '0.1.0'

async function main(): Promise<void> {
  // 1. env schema parses (exits with one clear line on failure)
  const config = loadConfig()
  const log = createLogger({ level: config.LOG_LEVEL, base: { app: 'api' } })

  // 2–5. Mongo → Redis → noeviction → indexes
  let clients: DbClients
  try {
    clients = await bootDataLayer({
      mongoUri: config.MONGODB_URI,
      redisUrl: config.REDIS_URL,
      ensureIndexes: config.NODE_ENV !== 'production',
    })
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }

  // Phase 3: webhook-ingest enqueue via BullMQ on the shared Redis.
  const { Queue } = await import('bullmq')
  const webhookIngestQueue = new Queue('webhook-ingest', { connection: { url: config.REDIS_URL } })

  // Phase 4: inbox service — outbound-message queue + Redis idempotency store.
  const { InboxService, redisIdempotencyStore, CatalogueService, KnowledgeService, OrdersService, PaymentsService, ObservabilityService, PlansService } = await import('@inboxbondhu/core')
  const outboundQueue = new Queue('outbound-message', { connection: { url: config.REDIS_URL } })
  const inboxService = new InboxService(redisIdempotencyStore(clients.redis), async (job) => {
    await outboundQueue.add('outbound-message', job)
  })

  // Phase 5: catalogue + knowledge + csv-import queue.
  const csvImportQueue = new Queue('csv-import', { connection: { url: config.REDIS_URL } })
  const catalogueService = new CatalogueService()
  const knowledgeService = new KnowledgeService()

  // Phase 7: orders + payments.
  const ordersService = new OrdersService(redisIdempotencyStore(clients.redis))
  const paymentsService = new PaymentsService()

  // Phase 8: ops + realtime.
  const observabilityService = new ObservabilityService()
  const plansService = new PlansService()
  const opsQueues = new Map(
    ['webhook-ingest', 'conversation-ai', 'outbound-message', 'csv-import', 'email', 'payment-events'].map(
      (name) => [name, new Queue(name, { connection: { url: config.REDIS_URL } })] as const,
    ),
  )

  const { createRealtimeGateway } = await import('./realtime/gateway.js')
  const app = createApp({
    clients,
    version: VERSION,
    startedAt: Date.now(),
    webhook: {
      redis: clients.redis,
      appSecret: config.META_APP_SECRET,
      verifyToken: config.META_VERIFY_TOKEN,
      journalDir: '/var/lib/inboxbondhu/journal', // D22
      enqueue: async (job) => {
        await webhookIngestQueue.add('webhook-ingest', job)
      },
    },
    auth: {
      jwtSecret: config.JWT_SECRET,
      jwtSecretPrevious: config.JWT_SECRET_PREVIOUS || undefined,
      pepper: config.PII_HASH_PEPPER,
      accessTtlSeconds: 15 * 60,
      refreshTtlDays: 30,
      maxSessions: config.MAX_CONCURRENT_SESSIONS,
      secureCookies: config.NODE_ENV === 'production',
    },
    inbox: { service: inboxService },
    orders: { orders: ordersService, payments: paymentsService },
    ops: {
      observability: observabilityService,
      plans: plansService,
      queues: opsQueues,
      ticketSecret: config.JWT_SECRET, // dedicated secret joins config in P9 hardening
    },
    catalogue: {
      catalogue: catalogueService,
      knowledge: knowledgeService,
      enqueueImport: async (job) => {
        await csvImportQueue.add('csv-import', job)
      },
    },
  })
  const server: Server = app.listen(config.PORT, '0.0.0.0', () => {
    log.info({ port: config.PORT }, 'api listening')
  })
  const realtime = createRealtimeGateway(server, clients.redis, config.JWT_SECRET)
  void realtime // fan-out consumers arrive with the dispatcher wiring below

  // Graceful shutdown: stop accepting, drain in-flight, close connections.
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'shutdown: draining')
    server.close(() => {
      void shutdownDataLayer(clients).then(() => {
        log.info('shutdown: complete')
        process.exit(0)
      })
    })
    // Hard stop if draining exceeds 10 s.
    setTimeout(() => {
      log.error('shutdown: drain timeout, forcing exit')
      process.exit(1)
    }, 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void main()
