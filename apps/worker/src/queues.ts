/**
 * The nine queues with the EXACT §13.1 settings. Registered at boot (boot
 * assertion step 6); processors stay empty until their phases:
 * webhook-ingest/outbound/media (P3), conversation-ai (P6), csv-import (P5),
 * payment-events (P7), email/notification (P8).
 */
export interface QueueSpec {
  name: string
  concurrency: number
  attempts: number
  /** BullMQ backoff options; email uses the custom 30s/2m/10m ladder. */
  backoff: { type: 'exponential' | 'fixed' | 'custom'; delay?: number }
}

export const QUEUE_SPECS: readonly QueueSpec[] = [
  { name: 'webhook-ingest', concurrency: 10, attempts: 5, backoff: { type: 'exponential', delay: 2_000 } },
  // conversation-ai concurrency is deliberately 3: bounds concurrent LLM spend,
  // matches the 1 vCPU Droplet. First number to raise when scaling.
  { name: 'conversation-ai', concurrency: 3, attempts: 2, backoff: { type: 'fixed', delay: 5_000 } },
  { name: 'outbound-message', concurrency: 5, attempts: 4, backoff: { type: 'exponential', delay: 3_000 } },
  { name: 'media-fetch', concurrency: 3, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  // email: 30 s / 2 m / 10 m ladder (PRD §2.1 email resilience)
  { name: 'email', concurrency: 3, attempts: 3, backoff: { type: 'custom' } },
  // csv-import concurrency 1 so checkpointing stays coherent.
  { name: 'csv-import', concurrency: 1, attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  { name: 'payment-events', concurrency: 3, attempts: 5, backoff: { type: 'exponential', delay: 5_000 } },
  { name: 'notification', concurrency: 5, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
  { name: 'dead-letter', concurrency: 1, attempts: 1, backoff: { type: 'fixed', delay: 0 } },
] as const

/** The email ladder: attempt 1 → 30 s, 2 → 2 m, 3 → 10 m. */
export function emailBackoffMs(attemptsMade: number): number {
  const ladder = [30_000, 120_000, 600_000] as const
  return ladder[Math.min(attemptsMade, ladder.length - 1)] ?? 600_000
}

/**
 * Every job payload carries workspaceId and requestId and reconstructs a
 * TenantContext before touching data (§13.1). Typed here so every future
 * processor starts from the right shape.
 */
export interface JobEnvelope<T = unknown> {
  workspaceId: string
  requestId: string
  payload: T
}
