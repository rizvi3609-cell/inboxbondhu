/**
 * Phase 3 processors — THIN adapters over packages/core functions.
 * webhook-ingest → processWebhookEvent; outbound-message → deliverOutbound;
 * media-fetch remains a logged stub until the Spaces integration (its consumer)
 * exists; conversation-ai stays empty until Phase 6.
 */
import type { Job, Processor } from 'bullmq'
import type { Queue } from 'bullmq'
import type { Logger } from 'pino'
import {
  processWebhookEvent, deliverOutboundMessage, CatalogueService,
  mongoTextRetriever, runAiPipeline,
  type Keyring,
} from '@inboxbondhu/core'
import type { LlmClient, MetaClient } from '@inboxbondhu/integrations'

export interface WebhookIngestJob {
  dedupeKey: string
  requestId: string
}

export interface OutboundMessageJob {
  workspaceId: string
  requestId: string
  payload: { messageId: string }
}

export function makeWebhookIngestProcessor(deps: {
  log: Logger
  queues: { conversationAi: Queue; mediaFetch: Queue }
  /** P9.1 (audit H-1): realtime publisher — message.created reaches the dashboard. */
  notify?: (room: string, event: string, payload: Record<string, unknown>) => void
}): Processor<WebhookIngestJob> {
  return async (job: Job<WebhookIngestJob>) => {
    const { dedupeKey, requestId } = job.data
    const outcome = await processWebhookEvent(dedupeKey, deps.notify)
    deps.log.info(
      { requestId, dedupeKey, status: outcome.status, workspaceId: outcome.workspaceId },
      'webhook-ingest processed',
    )
    if (outcome.status === 'orphaned') {
      // Unknown page: stored orphaned, never rejected — and it ALERTS.
      deps.log.warn({ requestId, dedupeKey }, 'ALERT webhook.orphaned — page not connected to any workspace')
      return
    }
    if (outcome.status !== 'processed' || !outcome.workspaceId) return

    for (const media of outcome.mediaJobs) {
      await deps.queues.mediaFetch.add('media-fetch', {
        workspaceId: outcome.workspaceId,
        requestId,
        payload: { ...media, messageId: outcome.messageId },
      })
    }
    if (outcome.enqueueAi) {
      await deps.queues.conversationAi.add('conversation-ai', {
        workspaceId: outcome.workspaceId,
        requestId,
        payload: { conversationId: outcome.conversationId, messageId: outcome.messageId },
      })
    }
  }
}

export interface CsvImportJob {
  workspaceId: string
  requestId: string
  payload: { importId: string }
}

/**
 * csv-import processor — concurrency 1 so checkpointing stays coherent.
 * The service resumes from lastProcessedRow; a crash redoes ≤ 100 rows with
 * upsert-idempotent writes (MVP gate #9).
 */
export function makeCsvImportProcessor(deps: {
  log: Logger
  /** P9.1 (audit M-3): checkpoint progress → import.progress socket event. */
  notify?: (room: string, event: string, payload: Record<string, unknown>) => void
}): Processor<CsvImportJob> {
  const catalogue = new CatalogueService()
  return async (job: Job<CsvImportJob>) => {
    const { workspaceId, requestId, payload } = job.data
    const result = await catalogue.processImport(workspaceId, payload.importId, deps.notify)
    deps.log.info({ requestId, workspaceId, importId: payload.importId, ...result }, 'csv-import finished')
  }
}

export interface ConversationAiJob {
  workspaceId: string
  requestId: string
  payload: { conversationId: string; messageId: string }
}

/**
 * conversation-ai processor — concurrency 3 (§13.1: bounds LLM spend).
 * PRD §2.7 concurrency lock: one job per conversation at a time via a Redis
 * lock; a locked conversation's job is delayed, not dropped.
 */
export function makeConversationAiProcessor(deps: {
  log: Logger
  llm: LlmClient
  quotaCheck?: (workspaceId: string) => Promise<{ aiPaused: boolean }>
  enqueueOutbound: (job: { workspaceId: string; requestId: string; payload: { messageId: string } }) => Promise<void>
  acquireConvLock: (conversationId: string) => Promise<boolean>
  releaseConvLock: (conversationId: string) => Promise<void>
}): Processor<ConversationAiJob> {
  return async (job: Job<ConversationAiJob>) => {
    const { workspaceId, requestId, payload } = job.data
    const locked = await deps.acquireConvLock(payload.conversationId)
    if (!locked) {
      // Sequential per conversation: retry shortly rather than racing.
      await job.moveToDelayed(Date.now() + 2_000, job.token)
      return
    }
    try {
      const result = await runAiPipeline(workspaceId, payload.conversationId, payload.messageId, requestId, {
        llm: deps.llm,
        retriever: mongoTextRetriever,
        enqueueOutbound: deps.enqueueOutbound,
        ...(deps.quotaCheck ? { quotaCheck: deps.quotaCheck } : {}),
      })
      deps.log.info(
        { requestId, workspaceId, conversationId: payload.conversationId, outcome: result.outcome, intent: result.intent, latencyMs: result.latencyMs },
        'conversation-ai',
      )
    } finally {
      await deps.releaseConvLock(payload.conversationId)
    }
  }
}

export function makeOutboundMessageProcessor(deps: {
  log: Logger
  meta: MetaClient
  keyring: Keyring
}): Processor<OutboundMessageJob> {
  return async (job: Job<OutboundMessageJob>) => {
    const { workspaceId, requestId, payload } = job.data
    const result = await deliverOutboundMessage(payload.messageId, workspaceId, deps.meta, deps.keyring)
    deps.log.info({ requestId, workspaceId, messageId: payload.messageId, status: result.status }, 'outbound-message')
    if (result.status === 'failed_retryable') {
      // Throw so BullMQ retries per the §13.1 table (exp 3 s ×4 → DLQ).
      throw new Error(`retryable send failure: ${result.failureCode}`)
    }
    // sent / failed_permanent / window_closed: terminal — no retry.
  }
}
