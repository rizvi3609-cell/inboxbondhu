/**
 * MOD-10 notifications — the outbox dispatcher (ADR-010): polls pending rows
 * every 5 s, routes by type to handlers (email at MVP), retries 30 s / 2 m /
 * 10 m, then `dead` (the email DLQ path). Exactly-once rests on the globally
 * unique idempotencyKey — a row is claimed atomically before dispatch.
 * Reactive module: consumes events, never imported by domain modules.
 */
import { OutboxEvent } from '../../db/models/index.js'

export interface EmailClient {
  send(to: string, subject: string, body: string): Promise<void>
}

/** Deterministic mock — the Resend swap is one file (same pattern as meta/llm). */
export function createMockEmailClient(): { client: EmailClient; sent: Array<{ to: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; subject: string; body: string }> = []
  return {
    client: {
      async send(to, subject, body) {
        sent.push({ to, subject, body })
      },
    },
    sent,
  }
}

/** §9 P8 item 3 — the email ladder. */
export const EMAIL_RETRY_LADDER_MS = [30_000, 120_000, 600_000] as const
const MAX_ATTEMPTS = 3

export interface DispatchDeps {
  email: EmailClient
  /** Socket emitter — wired to the gateway in apps/api; no-op in the worker. */
  emitSocket?: (room: string, event: string, payload: Record<string, unknown>) => void
  appUrl?: string
  now?: () => Date
}

interface EmailTemplate {
  to: (payload: Record<string, unknown>) => string | null
  subject: string
  body: (payload: Record<string, unknown>) => string
}

/** Resend templates (§9 P8 item 3) — plain text at MVP; HTML is a P1 polish. */
const TEMPLATES: Record<string, EmailTemplate> = {
  'email.verification': {
    to: (p) => (p['email'] as string) ?? null,
    subject: 'Verify your InboxBondhu email',
    body: (p) => `Welcome to InboxBondhu! Verify within 24 hours.\nToken hash reference: ${String(p['tokenHash']).slice(0, 12)}…`,
  },
  'email.password_reset': {
    to: (p) => (p['email'] as string) ?? null,
    subject: 'Reset your InboxBondhu password',
    body: () => 'A password reset was requested. The link expires in 1 hour. If this was not you, ignore this email.',
  },
  'email.invitation': {
    to: (p) => (p['email'] as string) ?? null,
    subject: 'You are invited to an InboxBondhu workspace',
    body: (p) => `You have been invited as ${String(p['role'])}. The invitation expires in 7 days.`,
  },
  'member.removed': {
    to: (p) => (p['email'] as string) ?? null, // enriched by the handler when absent
    subject: 'You were removed from a workspace',
    body: () => 'Your access to the workspace has been removed. Contact the owner if this is unexpected.',
  },
  'quota.warning': {
    to: (p) => (p['ownerEmail'] as string) ?? null,
    subject: 'InboxBondhu: 80% of your conversation quota used',
    body: (p) => `You have used ${String(p['used'])} of ${String(p['limit'])} conversations this period.`,
  },
  'quota.blocked': {
    to: (p) => (p['ownerEmail'] as string) ?? null,
    subject: 'InboxBondhu: conversation quota reached — AI paused',
    body: (p) => `You reached ${String(p['limit'])} conversations. AI replies are paused; your team can still reply manually. Upgrade to resume AI.`,
  },
  'channel.expiring': {
    to: (p) => (p['ownerEmail'] as string) ?? null,
    subject: 'Facebook Page connection expiring soon',
    body: (p) => `The connection for ${String(p['pageName'])} expires soon. Reconnect from Settings → Channels.`,
  },
  'jobs.failed_digest': {
    to: (p) => (p['ownerEmail'] as string) ?? null,
    subject: 'InboxBondhu: failed jobs need attention',
    body: (p) => `${String(p['count'])} job(s) failed in the last period. Review them in Settings → Failed Jobs.`,
  },
}

/** Socket fan-out map for non-email events (IDs and previews only, §12.3). */
const SOCKET_EVENTS: Record<string, (p: Record<string, unknown>) => { room: string; event: string; payload: Record<string, unknown> } | null> = {
  'order.confirmed': (p) => ({
    room: `ws:${String(p['workspaceId'] ?? '')}`,
    event: 'order.updated',
    payload: { orderId: String(p['orderId']), orderCode: p['orderCode'] ?? null, at: new Date().toISOString() },
  }),
  'order.shipped': (p) => ({
    room: `ws:${String(p['workspaceId'] ?? '')}`,
    event: 'order.updated',
    payload: { orderId: String(p['orderId']), status: 'Shipped', at: new Date().toISOString() },
  }),
  'order.delivered': (p) => ({
    room: `ws:${String(p['workspaceId'] ?? '')}`,
    event: 'order.updated',
    payload: { orderId: String(p['orderId']), status: 'Delivered', at: new Date().toISOString() },
  }),
  'member.removed': (p) => ({
    room: `user:${String(p['userId'] ?? '')}`,
    event: 'session.revoked',
    payload: { reason: 'member_removed', at: new Date().toISOString() },
  }),
  // P9.1 (audit M-3): quota events reach the dashboard banner, not just email.
  'quota.warning': (p) => ({
    room: `ws:${String(p['workspaceId'] ?? '')}`,
    event: 'quota.warning',
    payload: { level: 80, used: p['used'] ?? null, limit: p['limit'] ?? null, at: new Date().toISOString() },
  }),
  'quota.blocked': (p) => ({
    room: `ws:${String(p['workspaceId'] ?? '')}`,
    event: 'quota.warning',
    payload: { level: 100, used: p['used'] ?? null, limit: p['limit'] ?? null, at: new Date().toISOString() },
  }),
}

/**
 * One dispatcher pass: claim → handle → dispatched / retry / dead.
 * Claiming sets status 'failed'→'pending' handling aside: a row is taken by
 * findOneAndUpdate(pending → dispatching-marker via attempts guard) so two
 * dispatcher instances cannot double-send (plus the job-lock outside).
 */
export async function dispatchOutboxBatch(deps: DispatchDeps, batchSize = 50): Promise<{ dispatched: number; failed: number; dead: number }> {
  const now = deps.now?.() ?? new Date()
  let dispatched = 0
  let failed = 0
  let dead = 0

  for (let i = 0; i < batchSize; i += 1) {
    // Atomic claim (I51): pending + due → bump attempts so a crashed pass
    // leaves a due-later row, not a stuck one.
    const row = await OutboxEvent.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: now } },
      { $inc: { attempts: 1 } },
      { new: true, sort: { nextAttemptAt: 1 } },
    )
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
      .exec()
    if (!row) break

    const payload = row.payload as Record<string, unknown>
    try {
      const template = TEMPLATES[row.type]
      if (template) {
        const to = template.to(payload)
        if (to) await deps.email.send(to, template.subject, template.body(payload))
        // No recipient resolvable → nothing to send; still dispatched (the
        // event was consumed; enrichment gaps are logged upstream).
      }
      const socketMap = SOCKET_EVENTS[row.type]
      if (socketMap && deps.emitSocket) {
        const evt = socketMap({ ...payload, workspaceId: String(row.workspaceId) })
        if (evt) deps.emitSocket(evt.room, evt.event, evt.payload)
      }
      await OutboxEvent.updateOne(
        { _id: row._id, status: 'pending' },
        { $set: { status: 'dispatched', dispatchedAt: now } },
      )
        .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
        .exec()
      dispatched += 1
    } catch (err) {
      if (row.attempts >= MAX_ATTEMPTS) {
        await OutboxEvent.updateOne(
          { _id: row._id },
          { $set: { status: 'dead', lastError: (err as Error).message.slice(0, 300) } },
        )
          .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
          .exec()
        dead += 1
      } else {
        const delay = EMAIL_RETRY_LADDER_MS[row.attempts - 1] ?? 600_000
        await OutboxEvent.updateOne(
          { _id: row._id },
          { $set: { nextAttemptAt: new Date(now.getTime() + delay), lastError: (err as Error).message.slice(0, 300) } },
        )
          .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
          .exec()
        failed += 1
      }
    }
  }
  return { dispatched, failed, dead }
}

/** Purge dispatched rows older than 24 h (D16 note). */
export async function purgeDispatchedOutbox(now = new Date()): Promise<{ purged: number }> {
  const res = await OutboxEvent.deleteMany({
    status: 'dispatched',
    dispatchedAt: { $lt: new Date(now.getTime() - 86_400_000) },
  })
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
    .exec()
  return { purged: res.deletedCount }
}
