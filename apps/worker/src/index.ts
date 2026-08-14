/**
 * apps/worker bootstrap — THIN. BullMQ registration with empty processors,
 * graceful drain on SIGTERM. Same fail-fast boot chain as the api.
 */
import { Worker, Queue, type Processor } from 'bullmq'
import { loadConfig } from '@inboxbondhu/config'
import { createLogger } from '@inboxbondhu/logger'
import {
  bootDataLayer, drainRedisBuffer, makeKeyring, shutdownDataLayer,
  sweepAbandonedOrders, sweepExpiredReservations, sweepStuckMessages,
  dispatchOutboxBatch, purgeDispatchedOutbox, createMockEmailClient,
  reconcileUsage, reconcileStock, PlansService, ChannelConnection,
  type DbClients,
} from '@inboxbondhu/core'
import { withJobLock } from './jobLock.js'
import { createMockLlmClient, createMockMetaClient } from '@inboxbondhu/integrations'
import { QUEUE_SPECS, emailBackoffMs, type JobEnvelope } from './queues.js'
import {
  makeConversationAiProcessor, makeCsvImportProcessor,
  makeOutboundMessageProcessor, makeWebhookIngestProcessor,
} from './processors.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const log = createLogger({ level: config.LOG_LEVEL, base: { app: 'worker' } })

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

  const connection = { url: config.REDIS_URL }

  // Boot assertion step 6: queues registered.
  const queues = QUEUE_SPECS.map(
    (spec) =>
      new Queue(spec.name, {
        connection,
        defaultJobOptions: {
          attempts: spec.attempts,
          backoff:
            spec.backoff.type === 'custom'
              ? { type: 'emailLadder' }
              : { type: spec.backoff.type, delay: spec.backoff.delay ?? 1000 },
          removeOnComplete: { age: 86_400 },
          removeOnFail: false, // DLQ path owns failed jobs
        },
      }),
  )

  // Phase 3 wires webhook-ingest + outbound-message; the rest stay no-ops
  // until their phases. OPEN QUESTION: the real Meta HTTP client needs live
  // app credentials — the mock keeps the pipeline provable; swap is one file.
  const keyring = makeKeyring(config.CHANNEL_TOKEN_MASTER_KEY, config.CHANNEL_TOKEN_KEY_VERSION)
  const { client: metaClient } = createMockMetaClient()

  const queueByName = new Map(queues.map((q) => [q.name, q]))
  const webhookIngest = makeWebhookIngestProcessor({
    log,
    queues: {
      conversationAi: queueByName.get('conversation-ai')!,
      mediaFetch: queueByName.get('media-fetch')!,
    },
  })
  const outboundMessage = makeOutboundMessageProcessor({ log, meta: metaClient, keyring })
  const csvImport = makeCsvImportProcessor({ log })

  // Phase 6: conversation-ai. OPEN QUESTION: mock LLM until a live key —
  // swap is createMockLlmClient → the real OpenAI client, one line.
  const { client: llmClient } = createMockLlmClient()
  const plansService = new PlansService()
  const conversationAi = makeConversationAiProcessor({
    log,
    llm: llmClient,
    quotaCheck: async (workspaceId) => {
      const s = await plansService.quotaStatus(workspaceId)
      await plansService.maybeWarn(workspaceId).catch(() => undefined) // 80/100% notices
      return { aiPaused: s.aiPaused }
    },
    enqueueOutbound: async (job) => {
      await queueByName.get('outbound-message')!.add('outbound-message', job as unknown as JobEnvelope)
    },
    // PRD §2.7 per-conversation concurrency lock (60 s TTL > 15 s deadline).
    acquireConvLock: async (conversationId) =>
      (await clients.redis.set(`lock:conv:${conversationId}`, '1', 'PX', 60_000, 'NX')) === 'OK',
    releaseConvLock: async (conversationId) => {
      await clients.redis.del(`lock:conv:${conversationId}`)
    },
  })

  const emptyProcessor: Processor<JobEnvelope> = (job) => {
    log.info({ queue: job.queueName, jobId: job.id, requestId: job.data.requestId }, 'no-op processor')
    return Promise.resolve()
  }

  const workers = QUEUE_SPECS.map((spec) => {
    const processor: Processor<never> =
      spec.name === 'webhook-ingest'
        ? (webhookIngest as Processor<never>)
        : spec.name === 'outbound-message'
          ? (outboundMessage as Processor<never>)
          : spec.name === 'csv-import'
            ? (csvImport as Processor<never>)
            : spec.name === 'conversation-ai'
              ? (conversationAi as Processor<never>)
              : (emptyProcessor as Processor<never>)
    return new Worker(spec.name, processor, {
      connection,
      concurrency: spec.concurrency,
      settings: {
        backoffStrategy: (attemptsMade: number) => emailBackoffMs(attemptsMade - 1),
      },
    })
  })

  // webhookBufferDrainer — every 30 s, replays the Redis outage buffer once
  // Mongo returns. Dedupe (I48) makes replay safe. Journal half lands in P8.
  // stuckMessageSweeper — every 30 s under the Redis job lock (§13.2 row 1):
  // queued > STUCK_MESSAGE_SECONDS → failed, surfaced in Failed Jobs.
  const stuckInterval = setInterval(() => {
    void withJobLock(clients.redis, 'stuckMessageSweeper', 25_000, () =>
      sweepStuckMessages(config.STUCK_MESSAGE_SECONDS),
    ).then((result) => {
      if (result && result.swept > 0) log.warn({ swept: result.swept }, 'stuckMessageSweeper marked messages failed')
    }).catch((err: Error) => log.warn({ err: err.message }, 'stuckMessageSweeper failed'))
  }, 30_000)
  stuckInterval.unref()

  // reservationExpirySweeper — every 5 min (§13.2): held past expiresAt →
  // released AND reserved decremented in ONE transaction (DB-07).
  const reservationInterval = setInterval(() => {
    void withJobLock(clients.redis, 'reservationExpirySweeper', 240_000, () =>
      sweepExpiredReservations(),
    ).then((r) => {
      if (r && r.released > 0) log.info({ released: r.released }, 'reservationExpirySweeper')
    }).catch((err: Error) => log.warn({ err: err.message }, 'reservationExpirySweeper failed'))
  }, 300_000)
  reservationInterval.unref()

  // abandonedOrderSweeper — every 15 min (§13.2): Collecting >24h stale →
  // Cancelled(system_abandoned), reservations released.
  const abandonedInterval = setInterval(() => {
    void withJobLock(clients.redis, 'abandonedOrderSweeper', 840_000, () =>
      sweepAbandonedOrders(config.ABANDONED_ORDER_HOURS),
    ).then((r) => {
      if (r && r.cancelled > 0) log.info({ cancelled: r.cancelled }, 'abandonedOrderSweeper')
    }).catch((err: Error) => log.warn({ err: err.message }, 'abandonedOrderSweeper failed'))
  }, 900_000)
  abandonedInterval.unref()

  // outboxDispatcher — every 5 s (§13.2): pending rows → email/socket,
  // 30s/2m/10m retries then dead. Mock email client until a Resend key
  // (same one-file-swap pattern as meta/llm).
  const { client: emailClient } = createMockEmailClient()
  const dispatcherInterval = setInterval(() => {
    void withJobLock(clients.redis, 'outboxDispatcher', 4_000, () =>
      dispatchOutboxBatch({ email: emailClient }),
    ).then((r) => {
      if (r && (r.dispatched > 0 || r.dead > 0)) log.info(r, 'outboxDispatcher')
    }).catch((err: Error) => log.warn({ err: err.message }, 'outboxDispatcher failed'))
  }, 5_000)
  dispatcherInterval.unref()

  // usageReconciler — hourly (§13.2): Mongo authoritative, Redis corrected.
  const usageInterval = setInterval(() => {
    void withJobLock(clients.redis, 'usageReconciler', 3_500_000, () => reconcileUsage())
      .then((r) => { if (r && r.reconciled > 0) log.info(r, 'usageReconciler') })
      .catch((err: Error) => log.warn({ err: err.message }, 'usageReconciler failed'))
  }, 3_600_000)
  usageInterval.unref()

  // tokenExpiryChecker — hourly (§13.2): channels expiring <7d → mark + notify.
  const tokenInterval = setInterval(() => {
    void withJobLock(clients.redis, 'tokenExpiryChecker', 3_500_000, async () => {
      const soon = new Date(Date.now() + 7 * 86_400_000)
      const expiring = await ChannelConnection.find({ status: 'active', tokenExpiresAt: { $lt: soon, $ne: null } })
        .setOptions({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' })
        .limit(100).exec()
      for (const ch of expiring) {
        log.warn({ workspaceId: String(ch.workspaceId), pageName: ch.pageName }, 'ALERT channel.expiring')
      }
      return { expiring: expiring.length }
    }).catch((err: Error) => log.warn({ err: err.message }, 'tokenExpiryChecker failed'))
  }, 3_600_000)
  tokenInterval.unref()

  // nightly integrity: stock reconciliation (§6.6) + outbox purge, daily 03:00-ish.
  const nightlyInterval = setInterval(() => {
    void withJobLock(clients.redis, 'nightlyIntegrityJob', 3_500_000, async () => {
      const stock = await reconcileStock()
      if (stock.mismatches.length > 0) {
        log.error({ mismatches: stock.mismatches }, 'ALERT order.oversell_detected — SEV: any occurrence pages')
      }
      const purged = await purgeDispatchedOutbox()
      return { checked: stock.checked, mismatches: stock.mismatches.length, purged: purged.purged }
    }).then((r) => { if (r) log.info(r, 'nightlyIntegrityJob') })
      .catch((err: Error) => log.warn({ err: err.message }, 'nightlyIntegrityJob failed'))
  }, 24 * 3_600_000)
  nightlyInterval.unref()

  const drainerInterval = setInterval(() => {
    void drainRedisBuffer(clients.redis, async (jobData) => {
      await queueByName.get('webhook-ingest')!.add('webhook-ingest', jobData as unknown as JobEnvelope)
    }).then(({ drained, deduped }) => {
      if (drained > 0 || deduped > 0) log.info({ drained, deduped }, 'webhookBufferDrainer')
    }).catch((err: Error) => log.warn({ err: err.message }, 'webhookBufferDrainer failed'))
  }, 30_000)
  drainerInterval.unref()

  log.info({ queues: QUEUE_SPECS.map((q) => q.name) }, 'worker ready')

  // Graceful drain: finish in-flight jobs, close queues, close connections.
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'worker shutdown: draining')
    void (async () => {
      await Promise.all(workers.map((w) => w.close())) // waits for in-flight jobs
      await Promise.all(queues.map((q) => q.close()))
      await shutdownDataLayer(clients)
      log.info('worker shutdown: complete')
      process.exit(0)
    })()
    setTimeout(() => {
      log.error('worker shutdown: drain timeout, forcing exit')
      process.exit(1)
    }, 30_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

void main()
