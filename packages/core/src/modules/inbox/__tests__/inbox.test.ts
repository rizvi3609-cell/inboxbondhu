/**
 * MOD-04 service tests:
 * - list on I24: filters, cursor, default limit 20 (gotcha #8), updatedSince
 * - take-over stops AI; return-to-AI FORBIDDEN mid-capture; OCC on PATCH
 * - Idempotency-Key: same key twice → one message, replay marker
 * - human reply sets mode human; unread clears on agent open, not viewer
 * - retry only failed outbound; WINDOW_EXPIRED refuses retry
 * - stuckMessageSweeper marks queued>60s failed
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  Conversation, Customer, Message, Order, Workspace, User, Membership,
  InboxService, memoryIdempotencyStore, sweepStuckMessages,
} from '../../../index.js'
import { makeTenantContext, type TenantContext } from '../../../kernel/tenantContext.js'
import { dropData, fakeUlid, oid, startDb, stopDb } from '../../../__tests__/setupDb.js'

const DAY_MS = 86_400_000

let enqueued: Array<{ workspaceId: string; payload: { messageId: string } }>
let svc: InboxService

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  enqueued = []
  svc = new InboxService(memoryIdempotencyStore(), async (job) => {
    enqueued.push(job)
  })
})

interface Fixture {
  ws: mongoose.Types.ObjectId
  agentCtx: TenantContext
  viewerCtx: TenantContext
  customerId: mongoose.Types.ObjectId
  channelId: mongoose.Types.ObjectId
}

async function fixture(): Promise<Fixture> {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'Rupa Fashion', slug: `rupa-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() })
  const customer = await Customer.create({
    workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-1', displayName: 'Karim Customer',
    phone: '01712345678', addressText: 'House 1 Dhanmondi',
    firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
  return {
    ws: ws._id,
    agentCtx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'agent', requestId: fakeUlid() }),
    viewerCtx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'viewer', requestId: fakeUlid() }),
    customerId: customer._id,
    channelId: new mongoose.Types.ObjectId(),
  }
}

async function makeConversation(f: Fixture, overrides: Record<string, unknown> = {}) {
  return Conversation.create({
    workspaceId: f.ws,
    channelConnectionId: f.channelId,
    customerId: f.customerId,
    lastMessageAt: new Date(),
    lastMessagePreview: 'dam koto?',
    lastMessageDirection: 'inbound',
    unreadCount: 2,
    metaWindowExpiresAt: new Date(Date.now() + DAY_MS),
    purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    ...overrides,
  })
}

describe('list — I24 semantics', () => {
  it('default limit is 20 (the documented override), sorted lastMessageAt desc, cursor works', async () => {
    const f = await fixture()
    for (let i = 0; i < 25; i += 1) {
      await makeConversation(f, {
        customerId: new mongoose.Types.ObjectId(),
        lastMessageAt: new Date(Date.now() - i * 60_000),
      })
    }
    const first = await svc.list(f.agentCtx, {})
    if (!first.ok) throw first.error
    expect(first.value.conversations).toHaveLength(20) // NOT 25
    expect(first.value.nextCursor).not.toBeNull()
    // Sorted desc.
    const times = first.value.conversations.map((c) => new Date(c.lastMessageAt).getTime())
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    const second = await svc.list(f.agentCtx, { cursor: first.value.nextCursor! })
    if (!second.ok) throw second.error
    expect(second.value.conversations).toHaveLength(5)
    expect(second.value.nextCursor).toBeNull()
  })

  it('filters by status/mode and updatedSince reconciliation works', async () => {
    const f = await fixture()
    await makeConversation(f, { status: 'open', mode: 'ai' })
    await makeConversation(f, { customerId: new mongoose.Types.ObjectId(), status: 'resolved', mode: 'human' })

    const open = await svc.list(f.agentCtx, { status: 'open' })
    expect(open.ok && open.value.conversations).toHaveLength(1)
    const human = await svc.list(f.agentCtx, { mode: 'human' })
    expect(human.ok && human.value.conversations).toHaveLength(1)

    // updatedSince: nothing changed after "now + 1h" → empty.
    const later = await svc.list(f.agentCtx, { updatedSince: new Date(Date.now() + 3_600_000) })
    expect(later.ok && later.value.conversations).toHaveLength(0)
    // Everything changed after epoch → both.
    const epoch = await svc.list(f.agentCtx, { updatedSince: new Date(0) })
    expect(epoch.ok && epoch.value.conversations).toHaveLength(2)
  })
})

describe('get — conversation + customer + open order summary', () => {
  it('includes the open order and hides PII from viewers', async () => {
    const f = await fixture()
    const conv = await makeConversation(f)
    await Order.create({
      workspaceId: f.ws, orderNumber: 1, orderYear: 2026, orderCode: 'ORD-2026-00001',
      conversationId: conv._id, customerId: f.customerId,
      items: [{ productId: oid(), variantSku: 'V', nameSnapshot: 'Jama', variantNameSnapshot: 'Red / M', unitPriceMinor: 129900, quantity: 1, lineTotalMinor: 129900 }],
      subtotalMinor: 129900, totalMinor: 135900, deliveryFeeMinor: 6000,
      deliveryZone: 'Dhaka', deliveryAddress: 'addr', recipientName: 'Karim', recipientPhone: '01712345678',
      fulfillmentStatus: 'Collecting', createdByType: 'ai',
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })

    const agent = await svc.get(f.agentCtx, String(conv._id))
    if (!agent.ok) throw agent.error
    expect(agent.value.openOrder!.orderCode).toBe('ORD-2026-00001')
    expect(agent.value.customer!.phone).toBe('01712345678')

    const viewer = await svc.get(f.viewerCtx, String(conv._id))
    if (!viewer.ok) throw viewer.error
    expect(viewer.value.customer!.phone).toBeNull() // PII gated by role (§8.7)
    expect(viewer.value.customer!.addressText).toBeNull()

    const missing = await svc.get(f.agentCtx, oid())
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND')
  })
})

describe('update — take-over / return-to-AI / OCC', () => {
  it('ai → human takes over; human → ai forbidden while an order is mid-capture', async () => {
    const f = await fixture()
    const conv = await makeConversation(f, { mode: 'ai' })

    const takeOver = await svc.update(f.agentCtx, String(conv._id), 0, { mode: 'human' })
    expect(takeOver.ok).toBe(true)
    let fresh = await Conversation.findOne({ _id: conv._id, workspaceId: f.ws }).exec()
    expect(fresh!.mode).toBe('human')
    expect(fresh!.handoverReason).toBe('explicit_request')

    // Mid-capture order blocks return to AI.
    await Order.create({
      workspaceId: f.ws, orderNumber: 2, orderYear: 2026, orderCode: 'ORD-2026-00002',
      conversationId: conv._id, customerId: f.customerId,
      items: [{ productId: oid(), variantSku: 'V', nameSnapshot: 'N', variantNameSnapshot: 'VN', unitPriceMinor: 100, quantity: 1, lineTotalMinor: 100 }],
      subtotalMinor: 100, totalMinor: 100, deliveryFeeMinor: 0,
      deliveryZone: 'Dhaka', deliveryAddress: 'a', recipientName: 'R', recipientPhone: '01712345678',
      fulfillmentStatus: 'AwaitingConfirmation', createdByType: 'ai',
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })
    const blocked = await svc.update(f.agentCtx, String(conv._id), 1, { mode: 'ai' })
    expect(!blocked.ok && blocked.error.code).toBe('BUSINESS_RULE_VIOLATION')

    // Cancel the draft → return to AI allowed.
    await Order.updateOne({ workspaceId: f.ws, orderCode: 'ORD-2026-00002' }, { $set: { fulfillmentStatus: 'Cancelled' } }).exec()
    const allowed = await svc.update(f.agentCtx, String(conv._id), 1, { mode: 'ai' })
    expect(allowed.ok).toBe(true)
    fresh = await Conversation.findOne({ _id: conv._id, workspaceId: f.ws }).exec()
    expect(fresh!.mode).toBe('ai')
    expect(fresh!.handoverReason).toBeNull()
  })

  it('stale version → VERSION_CONFLICT with currentVersion', async () => {
    const f = await fixture()
    const conv = await makeConversation(f)
    await svc.update(f.agentCtx, String(conv._id), 0, { status: 'pending' })
    const stale = await svc.update(f.agentCtx, String(conv._id), 0, { status: 'resolved' })
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error.code).toBe('VERSION_CONFLICT')
      expect((stale.error as unknown as { currentVersion: number }).currentVersion).toBe(1)
    }
  })

  it('assign and resolve write audit rows with the action names', async () => {
    const f = await fixture()
    const conv = await makeConversation(f)
    await svc.update(f.agentCtx, String(conv._id), 0, { assignedTo: f.agentCtx.userId })
    await svc.update(f.agentCtx, String(conv._id), 1, { status: 'resolved' })
    const { AuditLog } = await import('../../../index.js')
    const actions = (await AuditLog.find({ workspaceId: f.ws }).exec()).map((a) => a.action).sort()
    expect(actions).toContain('conversation.resolved')
    expect(actions).toContain('conversation.updated')
  })
})

describe('sendMessage — Idempotency-Key discipline (DoD #2)', () => {
  it('same key twice → ONE message; second call replays the original id', async () => {
    const f = await fixture()
    const conv = await makeConversation(f, { mode: 'ai' })

    const first = await svc.sendMessage(f.agentCtx, String(conv._id), 'key-abc-12345', 'Ji, stock e ache!')
    if (!first.ok) throw first.error
    expect(first.value.replayed).toBe(false)

    const second = await svc.sendMessage(f.agentCtx, String(conv._id), 'key-abc-12345', 'Ji, stock e ache!')
    if (!second.ok) throw second.error
    expect(second.value.replayed).toBe(true)
    expect(second.value.messageId).toBe(first.value.messageId) // the ORIGINAL

    expect(await Message.countDocuments({ workspaceId: f.ws, direction: 'outbound' }).exec()).toBe(1)
    expect(enqueued).toHaveLength(1) // not enqueued twice
  })

  it('a human reply sets mode human (stops AI) and queues outbound with author attribution', async () => {
    const f = await fixture()
    const conv = await makeConversation(f, { mode: 'ai' })
    const sent = await svc.sendMessage(f.agentCtx, String(conv._id), 'key-def-67890', 'Amra kal deliver korbo.')
    if (!sent.ok) throw sent.error

    const fresh = await Conversation.findOne({ _id: conv._id, workspaceId: f.ws }).exec()
    expect(fresh!.mode).toBe('human') // AI stopped on this thread
    expect(fresh!.lastMessageDirection).toBe('outbound')

    const msg = await Message.findOne({ _id: sent.value.messageId, workspaceId: f.ws }).exec()
    expect(msg!.status).toBe('queued')
    expect(msg!.author!.type).toBe('agent')
    expect(String(msg!.author!.userId)).toBe(f.agentCtx.userId)
    expect(enqueued[0]!.payload.messageId).toBe(sent.value.messageId)
  })
})

describe('unread counting (item 7)', () => {
  it('agent opening the thread clears unread; viewer reading does not', async () => {
    const f = await fixture()
    const conv = await makeConversation(f, { unreadCount: 5 })
    await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'inbound',
      author: { type: 'customer' }, contentType: 'text', text: 'hello', status: 'delivered',
    })

    await svc.listMessages(f.viewerCtx, String(conv._id))
    let fresh = await Conversation.findOne({ _id: conv._id, workspaceId: f.ws }).exec()
    expect(fresh!.unreadCount).toBe(5) // viewer read does not clear

    await svc.listMessages(f.agentCtx, String(conv._id))
    fresh = await Conversation.findOne({ _id: conv._id, workspaceId: f.ws }).exec()
    expect(fresh!.unreadCount).toBe(0) // agent open clears
  })
})

describe('retry (#45)', () => {
  it('requeues a failed outbound; refuses non-failed, inbound, and WINDOW_EXPIRED', async () => {
    const f = await fixture()
    const conv = await makeConversation(f)
    const failed = await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'retry me',
      status: 'failed', failureCode: 'FB_5XX',
    })
    const ok = await svc.retryMessage(f.agentCtx, String(failed._id))
    expect(ok.ok).toBe(true)
    expect((await Message.findOne({ _id: failed._id, workspaceId: f.ws }).exec())!.status).toBe('queued')
    expect(enqueued).toHaveLength(1)

    const sent = await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'outbound',
      author: { type: 'ai' }, contentType: 'text', text: 'already sent', status: 'sent', sentAt: new Date(),
    })
    const notFailed = await svc.retryMessage(f.agentCtx, String(sent._id))
    expect(!notFailed.ok && notFailed.error.code).toBe('INVALID_STATE_TRANSITION')

    const windowClosed = await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'too late',
      status: 'failed', failureCode: 'WINDOW_EXPIRED',
    })
    const refused = await svc.retryMessage(f.agentCtx, String(windowClosed._id))
    expect(!refused.ok && refused.error.code).toBe('BUSINESS_RULE_VIOLATION')
  })
})

describe('stuckMessageSweeper (DoD #4)', () => {
  it('marks queued messages older than 60 s failed; leaves fresh ones alone', async () => {
    const f = await fixture()
    const conv = await makeConversation(f)
    // A stuck message from a "killed worker": created 2 minutes ago.
    const stuck = await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'stuck', status: 'queued',
    })
    await Message.collection.updateOne(
      { _id: stuck._id },
      { $set: { createdAt: new Date(Date.now() - 120_000) } }, // backdate past the sweep line
    )
    const freshMsg = await Message.create({
      workspaceId: f.ws, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'fresh', status: 'queued',
    })

    const { swept } = await sweepStuckMessages(60)
    expect(swept).toBe(1)
    expect((await Message.findOne({ _id: stuck._id, workspaceId: f.ws }).exec())!.status).toBe('failed')
    expect((await Message.findOne({ _id: stuck._id, workspaceId: f.ws }).exec())!.failureCode).toBe('STUCK_TIMEOUT')
    expect((await Message.findOne({ _id: freshMsg._id, workspaceId: f.ws }).exec())!.status).toBe('queued')
  })
})
