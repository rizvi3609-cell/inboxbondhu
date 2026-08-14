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
  processWebhookEvent, deliverOutboundMessage,
  type Keyring,
} from '@inboxbondhu/core'
import type { MetaClient } from '@inboxbondhu/integrations'

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
}): Processor<WebhookIngestJob> {
  return async (job: Job<WebhookIngestJob>) => {
    const { dedupeKey, requestId } = job.data
    const outcome = await processWebhookEvent(dedupeKey)
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
