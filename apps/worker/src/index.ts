/**
 * apps/worker bootstrap — THIN. BullMQ registration with empty processors,
 * graceful drain on SIGTERM. Same fail-fast boot chain as the api.
 */
import { Worker, Queue, type Processor } from 'bullmq'
import { loadConfig } from '@inboxbondhu/config'
import { createLogger } from '@inboxbondhu/logger'
import { bootDataLayer, shutdownDataLayer, type DbClients } from '@inboxbondhu/core'
import { QUEUE_SPECS, emailBackoffMs, type JobEnvelope } from './queues.js'

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

  // Empty processors — Phase 0 proves the pipeline; phases 3–8 fill them in.
  const emptyProcessor: Processor<JobEnvelope> = (job) => {
    log.info({ queue: job.queueName, jobId: job.id, requestId: job.data.requestId }, 'no-op processor')
    return Promise.resolve()
  }

  const workers = QUEUE_SPECS.map(
    (spec) =>
      new Worker<JobEnvelope>(spec.name, emptyProcessor, {
        connection,
        concurrency: spec.concurrency,
        settings: {
          backoffStrategy: (attemptsMade: number) => emailBackoffMs(attemptsMade - 1),
        },
      }),
  )

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
