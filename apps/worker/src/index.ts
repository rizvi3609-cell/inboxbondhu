/**
 * apps/worker bootstrap — THIN. BullMQ registration with empty processors,
 * graceful drain on SIGTERM. Same fail-fast boot chain as the api.
 */
import { Worker, Queue, type Processor } from 'bullmq'
import { loadConfig } from '@inboxbondhu/config'
import { createLogger } from '@inboxbondhu/logger'
import {
  bootDataLayer, drainRedisBuffer, makeKeyring, shutdownDataLayer, sweepStuckMessages,
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
  const conversationAi = makeConversationAiProcessor({
    log,
    llm: llmClient,
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
