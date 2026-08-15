/**
 * MOD-04 inbox service — conversation list (I24, default limit 20 — the
 * documented override), thread rendering (I28), take-over/return-to-AI/assign/
 * resolve with OCC, the manual reply path (Idempotency-Key), retry, unread
 * clearing, and the stuck-message sweep.
 */
import mongoose from 'mongoose'
import { AppError, VersionConflictError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import {
  AuditLog, Conversation, Customer, Message, Order,
} from '../../db/models/index.js'

const MID_CAPTURE_STATES = ['Collecting', 'AwaitingConfirmation'] as const

export interface ListConversationsQuery {
  status?: 'open' | 'pending' | 'resolved'
  mode?: 'ai' | 'human'
  assignedTo?: string
  channelId?: string
  q?: string
  /** Socket-reconnect reconciliation (§12.4) — built now, not later. */
  updatedSince?: Date
  cursor?: string // lastMessageAt ISO of the previous page's last row
  limit?: number // default 20 (gotcha #8 — every other list defaults 25)
}

/**
 * Idempotency store for POST /conversations/:id/messages. Redis-backed in
 * production, in-memory in tests.
 * OPEN QUESTION: no collection in the 19 stores idempotency replay bodies;
 * Redis (24 h TTL) is the narrow interim. If Redis loses the key inside the
 * retry window a duplicate outbound message is possible — flagged vs INV-11.
 */
export interface IdempotencyStore {
  /**
   * Atomically claim the key. Returns null if this caller won the claim;
   * otherwise the previously stored messageId (or 'PENDING' if a concurrent
   * claimant has not yet finalised — treated as replay-in-progress).
   */
  claim(workspaceId: string, key: string): Promise<string | null>
  /** Replace the PENDING placeholder with the concrete message id. */
  finalise(workspaceId: string, key: string, messageId: string): Promise<void>
}

export function memoryIdempotencyStore(): IdempotencyStore {
  const seen = new Map<string, string>()
  return {
    async claim(workspaceId, key) {
      const k = `${workspaceId}:${key}`
      const existing = seen.get(k) ?? null
      if (existing) return existing
      seen.set(k, 'PENDING')
      return null
    },
    async finalise(workspaceId, key, messageId) {
      seen.set(`${workspaceId}:${key}`, messageId)
    },
  }
}

export function redisIdempotencyStore(redis: import('ioredis').Redis): IdempotencyStore {
  return {
    async claim(workspaceId, key) {
      const k = `idem:${workspaceId}:${key}`
      const set = await redis.set(k, 'PENDING', 'EX', 86_400, 'NX')
      if (set === 'OK') return null
      return redis.get(k)
    },
    async finalise(workspaceId, key, messageId) {
      await redis.set(`idem:${workspaceId}:${key}`, messageId, 'EX', 86_400)
    },
  }
}

export class InboxService {
  constructor(
    private readonly idempotency: IdempotencyStore,
    private readonly enqueueOutbound: (job: {
      workspaceId: string
      requestId: string
      payload: { messageId: string }
    }) => Promise<void>,
    /** P9.1 (audit H-1): realtime hint sink, injected — inbox never imports notifications (§5.1). */
    private readonly notify?: (room: string, event: string, payload: Record<string, unknown>) => void,
  ) {}

  // ── #40 GET /conversations ────────────────────────────────────────────────

  async list(ctx: TenantContext, query: ListConversationsQuery) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100) // default 20 — documented override
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId }
    if (query.status) filter['status'] = query.status
    if (query.mode) filter['mode'] = query.mode
    if (query.assignedTo) filter['assignedTo'] = query.assignedTo
    if (query.channelId) filter['channelConnectionId'] = query.channelId
    if (query.updatedSince) filter['updatedAt'] = { $gt: query.updatedSince }
    if (query.cursor) filter['lastMessageAt'] = { $lt: new Date(query.cursor) }
    if (query.q) filter['lastMessagePreview'] = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' }

    const rows = await Conversation.find(filter)
      .sort({ lastMessageAt: -1 }) // I24
      .limit(limit + 1)
      .exec()

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const customerIds = page.map((c) => c.customerId)
    const customers = await Customer.find({ workspaceId: ctx.workspaceId, _id: { $in: customerIds } }).exec()
    const customerById = new Map(customers.map((c) => [String(c._id), c]))

    return Result.ok({
      conversations: page.map((c) => {
        const cust = customerById.get(String(c.customerId))
        return {
          id: String(c._id),
          status: c.status,
          mode: c.mode,
          assignedTo: c.assignedTo ? String(c.assignedTo) : null,
          customer: cust ? { id: String(cust._id), displayName: cust.displayName } : null,
          lastMessageAt: c.lastMessageAt,
          lastMessagePreview: c.lastMessagePreview,
          lastMessageDirection: c.lastMessageDirection,
          unreadCount: c.unreadCount,
          metaWindowExpiresAt: c.metaWindowExpiresAt,
          tags: c.tags,
          version: c.version,
        }
      }),
      nextCursor: hasMore ? page[page.length - 1]!.lastMessageAt.toISOString() : null,
    })
  }

  // ── #41 GET /conversations/:id — + customer + open order summary ─────────

  async get(ctx: TenantContext, conversationId: string) {
    const conv = await Conversation.findOne({ _id: conversationId, workspaceId: ctx.workspaceId }).exec()
    if (!conv) return Result.err(new AppError('NOT_FOUND', 'Conversation not found.'))

    const customer = await Customer.findOne({ _id: conv.customerId, workspaceId: ctx.workspaceId }).exec()
    const openOrder = await Order.findOne({
      workspaceId: ctx.workspaceId,
      conversationId: conv._id,
      fulfillmentStatus: { $in: ['Collecting', 'AwaitingConfirmation', 'Confirmed', 'Processing'] },
    })
      .sort({ createdAt: -1 })
      .exec()

    return Result.ok({
      id: String(conv._id),
      status: conv.status,
      mode: conv.mode,
      assignedTo: conv.assignedTo ? String(conv.assignedTo) : null,
      handoverReason: conv.handoverReason,
      lastMessageAt: conv.lastMessageAt,
      unreadCount: conv.unreadCount,
      messageCount: conv.messageCount,
      metaWindowExpiresAt: conv.metaWindowExpiresAt,
      tags: conv.tags,
      version: conv.version,
      customer: customer
        ? {
            id: String(customer._id),
            displayName: customer.displayName,
            // PII visible to agent+ only — the route gates viewer via role
            phone: ctx.role === 'viewer' ? null : customer.phone,
            addressText: ctx.role === 'viewer' ? null : customer.addressText,
            deliveryZone: customer.deliveryZone,
            orderCount: customer.orderCount,
            totalSpentMinor: customer.totalSpentMinor,
          }
        : null,
      openOrder: openOrder
        ? {
            id: String(openOrder._id),
            orderCode: openOrder.orderCode,
            fulfillmentStatus: openOrder.fulfillmentStatus,
            totalMinor: openOrder.totalMinor,
          }
        : null,
    })
  }

  // ── #43 GET /conversations/:id/messages — cursor asc on I28 ─────────────

  async listMessages(
    ctx: TenantContext,
    conversationId: string,
    opts: { cursor?: string; limit?: number; markRead?: boolean } = {},
  ) {
    const conv = await Conversation.findOne({ _id: conversationId, workspaceId: ctx.workspaceId }).exec()
    if (!conv) return Result.err(new AppError('NOT_FOUND', 'Conversation not found.'))

    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId, conversationId: conv._id }
    if (opts.cursor) filter['createdAt'] = { $gt: new Date(opts.cursor) }

    const rows = await Message.find(filter).sort({ createdAt: 1 }).limit(limit + 1).exec() // I28
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    // Unread clearing: an agent opening the thread clears the badge (item 7).
    // Viewers reading do not — they cannot act on the thread.
    if ((opts.markRead ?? true) && ctx.role !== 'viewer' && conv.unreadCount > 0) {
      await Conversation.updateOne(
        { _id: conv._id, workspaceId: ctx.workspaceId },
        { $set: { unreadCount: 0 } },
      ).exec()
    }

    return Result.ok({
      messages: page.map((m) => ({
        id: String(m._id),
        direction: m.direction,
        author: { type: m.author!.type, userId: m.author!.userId ? String(m.author!.userId) : null },
        contentType: m.contentType,
        text: m.text,
        attachments: m.attachments,
        status: m.status,
        failureCode: m.failureCode,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        createdAt: (m as unknown as { createdAt: Date }).createdAt,
      })),
      nextCursor: hasMore
        ? (page[page.length - 1] as unknown as { createdAt: Date }).createdAt.toISOString()
        : null,
    })
  }

  // ── #42 PATCH /conversations/:id — OCC + mode transitions ────────────────

  async update(
    ctx: TenantContext,
    conversationId: string,
    expectedVersion: number,
    changes: {
      status?: 'open' | 'pending' | 'resolved'
      mode?: 'ai' | 'human'
      assignedTo?: string | null
      tags?: string[]
    },
  ): Promise<Result<{ version: number }, AppError>> {
    const conv = await Conversation.findOne({ _id: conversationId, workspaceId: ctx.workspaceId }).exec()
    if (!conv) return Result.err(new AppError('NOT_FOUND', 'Conversation not found.'))

    // Return to AI is FORBIDDEN while an order is mid-capture (§9 P4 item 4).
    if (changes.mode === 'ai' && conv.mode === 'human') {
      const midCapture = await Order.findOne({
        workspaceId: ctx.workspaceId,
        conversationId: conv._id,
        fulfillmentStatus: { $in: [...MID_CAPTURE_STATES] },
      }).exec()
      if (midCapture) {
        return Result.err(
          new AppError('BUSINESS_RULE_VIOLATION', 'Cannot return to AI while an order is being captured. Finish or cancel the draft first.'),
        )
      }
    }

    const set: Record<string, unknown> = {}
    if (changes.status !== undefined) set['status'] = changes.status
    if (changes.mode !== undefined) {
      set['mode'] = changes.mode
      if (changes.mode === 'human') set['handoverReason'] = 'explicit_request' // take-over
      if (changes.mode === 'ai') set['handoverReason'] = null
    }
    if (changes.assignedTo !== undefined) {
      set['assignedTo'] = changes.assignedTo
      set['assignedAt'] = changes.assignedTo ? new Date() : null
    }
    if (changes.tags !== undefined) set['tags'] = changes.tags
    if (Object.keys(set).length === 0) {
      return Result.err(new AppError('VALIDATION_FAILED', 'Nothing to update.'))
    }

    const res = await Conversation.updateOne(
      { _id: conv._id, workspaceId: ctx.workspaceId, version: expectedVersion },
      { $set: set },
    ).exec()
    if (res.matchedCount === 0) {
      const fresh = await Conversation.findOne({ _id: conv._id, workspaceId: ctx.workspaceId }).exec()
      return Result.err(new VersionConflictError(fresh?.version ?? 0, Object.keys(set)))
    }

    await AuditLog.create({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action:
        changes.mode === 'human' ? 'conversation.taken_over'
        : changes.mode === 'ai' ? 'conversation.returned_to_ai'
        : changes.status === 'resolved' ? 'conversation.resolved'
        : 'conversation.updated',
      resourceType: 'conversation',
      resourceId: String(conv._id),
      before: { status: conv.status, mode: conv.mode, assignedTo: conv.assignedTo ? String(conv.assignedTo) : null },
      after: set,
      requestId: ctx.requestId,
    })
    // P9.1 (audit H-1): take-over/resolve/assign reflected live in other tabs.
    this.notify?.(`ws:${ctx.workspaceId}`, 'conversation.updated', {
      conversationId: String(conv._id),
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.mode !== undefined ? { mode: changes.mode } : {}),
      at: new Date().toISOString(),
    })

    return Result.ok({ version: expectedVersion + 1 })
  }

  // ── #44 POST /conversations/:id/messages — Idempotency-Key required ─────

  async sendMessage(
    ctx: TenantContext,
    conversationId: string,
    idempotencyKey: string,
    text: string,
  ): Promise<Result<{ messageId: string; replayed: boolean }, AppError>> {
    const conv = await Conversation.findOne({ _id: conversationId, workspaceId: ctx.workspaceId }).exec()
    if (!conv) return Result.err(new AppError('NOT_FOUND', 'Conversation not found.'))

    // Idempotency: same key twice → the ORIGINAL message, 200 replay.
    const existing = await this.idempotency.claim(ctx.workspaceId, idempotencyKey)
    if (existing && existing !== 'PENDING') {
      return Result.ok({ messageId: existing, replayed: true })
    }
    if (existing === 'PENDING') {
      // A concurrent request with the same key is mid-flight; treat as replay
      // rather than double-sending (the racer will finalise).
      return Result.err(new AppError('DUPLICATE_RESOURCE', 'This request is already being processed.'))
    }

    const message = await Message.create({
      workspaceId: ctx.workspaceId,
      conversationId: conv._id,
      direction: 'outbound',
      author: { type: 'agent', userId: new mongoose.Types.ObjectId(ctx.userId) },
      contentType: 'text',
      text,
      status: 'queued',
    })
    await this.idempotency.finalise(ctx.workspaceId, idempotencyKey, String(message._id))

    // A human reply SETS mode: 'human' — stops AI replies on this thread.
    await Conversation.updateOne(
      { _id: conv._id, workspaceId: ctx.workspaceId },
      {
        $set: {
          mode: 'human',
          lastMessageAt: new Date(),
          lastMessagePreview: text.slice(0, 140),
          lastMessageDirection: 'outbound',
        },
        $inc: { messageCount: 1 },
      },
    ).exec()

    await this.enqueueOutbound({
      workspaceId: ctx.workspaceId,
      requestId: ctx.requestId,
      payload: { messageId: String(message._id) },
    })

    // P9.1 (audit H-1): other agents' tabs see the reply within 1 s (§12.3).
    this.notify?.(`ws:${ctx.workspaceId}`, 'message.created', {
      conversationId: String(conv._id),
      messageId: String(message._id),
      preview: text.slice(0, 140),
      direction: 'outbound',
      at: new Date().toISOString(),
    })

    return Result.ok({ messageId: String(message._id), replayed: false })
  }

  // ── #45 POST /messages/:id/retry ─────────────────────────────────────────

  async retryMessage(ctx: TenantContext, messageId: string): Promise<Result<{ requeued: boolean }, AppError>> {
    const message = await Message.findOne({ _id: messageId, workspaceId: ctx.workspaceId }).exec()
    if (!message) return Result.err(new AppError('NOT_FOUND', 'Message not found.'))
    if (message.direction !== 'outbound' || message.status !== 'failed') {
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Only failed outbound messages can be retried.'))
    }
    if (message.failureCode === 'WINDOW_EXPIRED') {
      // Retrying cannot reopen Meta's 24 h window — refuse loudly.
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', 'The 24-hour messaging window has closed. The customer must message first.'))
    }
    await Message.updateOne(
      { _id: message._id, workspaceId: ctx.workspaceId, status: 'failed' },
      { $set: { status: 'queued', failureCode: null, failureDetail: null } },
    ).exec()
    await this.enqueueOutbound({
      workspaceId: ctx.workspaceId,
      requestId: ctx.requestId,
      payload: { messageId: String(message._id) },
    })
    return Result.ok({ requeued: true })
  }
}

// ── stuckMessageSweeper (item 8; §13.2 row 1) ──────────────────────────────

/**
 * Every 30 s: outbound messages still `queued` older than STUCK_MESSAGE_SECONDS
 * → `failed` (STUCK_TIMEOUT), so a killed worker cannot strand a reply.
 * Runs under the Redis job lock; socket emission joins in Phase 8 — the DB
 * write here is the authoritative record (§12.4).
 */
export async function sweepStuckMessages(olderThanSeconds = 60): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000)
  const res = await Message.updateMany(
    { status: 'queued', createdAt: { $lt: cutoff } }, // I30 partial index
    { $set: { status: 'failed', failureCode: 'STUCK_TIMEOUT', failureDetail: `queued > ${olderThanSeconds}s — worker dead or queue stalled` } },
  )
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' }) // cross-tenant sweep
    .exec()
  return { swept: res.modifiedCount }
}
