import { z } from 'zod'
import { isoDate, moneyMinor, objectIdString, periodKey, ulidString } from './common.js'

// ─── outboxEvents (D16) — ADR-010 ────────────────────────────────────────────

export const outboxStatus = z.enum(['pending', 'dispatched', 'failed', 'dead'])

export const OutboxEventDoc = z
  .object({
    workspaceId: objectIdString,
    type: z.string().min(1), // e.g. order.confirmed, email.verification
    payload: z.record(z.unknown()), // ≤ 16 KB
    /** Globally unique — the exactly-once guarantee (DB-06). */
    idempotencyKey: z.string().min(1),
    status: outboxStatus.default('pending'),
    attempts: z.number().int().min(0).default(0),
    nextAttemptAt: isoDate,
    dispatchedAt: isoDate.nullish(),
    lastError: z.string().nullish(),
  })
  .strict()
export type OutboxEventDoc = z.infer<typeof OutboxEventDoc>

// ─── usageLedger (D17) ───────────────────────────────────────────────────────

export const UsageLedgerDoc = z
  .object({
    workspaceId: objectIdString,
    periodKey, // unique with workspaceId, YYYY-MM
    plan: z.enum(['trial', 'starter', 'growth']),
    conversationsUsed: z.number().int().min(0).default(0),
    /** Snapshotted at period start — a mid-month upgrade never rewrites history. */
    conversationsLimit: z.number().int().min(0),
    productsCount: z.number().int().min(0).default(0),
    aiRepliesGenerated: z.number().int().min(0).default(0),
    aiCostMinor: moneyMinor.default(0),
    messagesSent: z.number().int().min(0).default(0),
    warningsSentAt: z.array(isoDate).default([]),
    reconciledAt: isoDate.nullish(),
  })
  .strict()
export type UsageLedgerDoc = z.infer<typeof UsageLedgerDoc>

// ─── auditLogs (D18) — append-only ───────────────────────────────────────────

export const actorType = z.enum(['user', 'system', 'ai'])

export const AuditLogDoc = z
  .object({
    workspaceId: objectIdString,
    actorId: z.string().min(1), // ObjectId string OR 'system'
    actorType,
    /** Role held AT THE TIME of the action — snapshotted, never resolved from today's memberships. */
    actorRole: z.enum(['owner', 'admin', 'agent', 'viewer']).nullish(),
    action: z.string().regex(/^[a-z_]+\.[a-z_]+$/), // resource.verb
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
    before: z.record(z.unknown()).nullish(), // changed fields only, PII-redacted
    after: z.record(z.unknown()).nullish(),
    requestId: ulidString, // ADR-009 — one ULID threads log ↔ trace ↔ audit
    ipHash: z.string().nullish(),
    userAgent: z.string().nullish(),
  })
  .strict()
export type AuditLogDoc = z.infer<typeof AuditLogDoc>
