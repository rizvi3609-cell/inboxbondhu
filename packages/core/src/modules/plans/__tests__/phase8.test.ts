/**
 * Phase 8 tests:
 * - DoD: 100% conversation quota pauses AI but NOT humans
 * - 80%/100% warnings emitted at most once per period (warningsSentAt)
 * - outbox dispatcher: templates, 30s/2m/10m ladder, dead after 3, purge
 * - usage reconciler: Mongo recomputed from conversations
 * - stock reconciliation: detects drift + oversell
 * - plan change: owner-only; upgrade raises current-period limit
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { createMockLlmClient } from '@inboxbondhu/integrations'
import {
  Conversation, Customer, Membership, Message, OutboxEvent, Product, StockReservation, UsageLedger, User, Workspace,
  PlansService, PLAN_LIMITS, reconcileUsage, reconcileStock,
  dispatchOutboxBatch, purgeDispatchedOutbox, createMockEmailClient, EMAIL_RETRY_LADDER_MS,
  InboxService, memoryIdempotencyStore, mongoTextRetriever, runAiPipeline, createIndexes,
} from '../../../index.js'
import { makeTenantContext, type TenantContext } from '../../../kernel/tenantContext.js'
import { DhakaTime } from '../../../kernel/dhakaTime.js'
import { dropData, fakeUlid, startDb, stopDb } from '../../../__tests__/setupDb.js'

const DAY_MS = 86_400_000

beforeAll(async () => {
  await startDb()
  await createIndexes()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

interface Fx {
  ws: string
  ownerCtx: TenantContext
  conversationId: string
  ownerId: string
}

async function fixture(plan: 'trial' | 'starter' | 'growth' = 'trial'): Promise<Fx> {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'P8 Fashion', slug: `p8-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id, plan,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() })
  const product = await Product.create({
    workspaceId: ws._id, sku: 'JAMA-01', name: 'Cotton Jama', basePriceMinor: 149900,
    variants: [{ sku: 'JAMA-01-M', name: 'M', stock: 5, reserved: 0, isActive: true }],
    status: 'active', searchText: ' ',
  })
  void product
  const customer = await Customer.create({
    workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-p8', displayName: 'P8 Customer',
    firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
  const conv = await Conversation.create({
    workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
    mode: 'ai', lastMessageAt: new Date(), metaWindowExpiresAt: new Date(Date.now() + DAY_MS),
    purgeAfter: new Date(Date.now() + 90 * DAY_MS),
  })
  return {
    ws: String(ws._id),
    ownerCtx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'owner', requestId: fakeUlid() }),
    conversationId: String(conv._id),
    ownerId: String(owner._id),
  }
}

describe('DoD — 100% quota pauses AI but NOT humans', () => {
  it('AI pipeline hands over at quota; the human reply path still works', async () => {
    const fx = await fixture('trial')
    const periodKey = DhakaTime.dhakaPeriodKey(new Date())
    // Fill the ledger to the trial limit (100).
    await UsageLedger.create({
      workspaceId: fx.ws, periodKey, plan: 'trial',
      conversationsUsed: 100, conversationsLimit: 100,
    })
    const plans = new PlansService()

    // AI path: paused.
    const inbound = await Message.create({
      workspaceId: fx.ws, conversationId: fx.conversationId, direction: 'inbound',
      author: { type: 'customer' }, contentType: 'text', text: 'Cotton Jama dam koto?', status: 'delivered',
    })
    const { client: llm, state } = createMockLlmClient()
    const result = await runAiPipeline(fx.ws, fx.conversationId, String(inbound._id), fakeUlid(), {
      llm, retriever: mongoTextRetriever,
      enqueueOutbound: async () => undefined,
      quotaCheck: async (wsId) => ({ aiPaused: (await plans.quotaStatus(wsId)).aiPaused }),
    })
    expect(result.outcome).toBe('handover')
    expect(result.handoverReason).toContain('quota')
    expect(state.calls).toBe(0) // zero LLM spend when blocked

    // Human path: still works.
    await Conversation.updateOne({ _id: fx.conversationId, workspaceId: fx.ws }, { $set: { mode: 'human' } }).exec()
    const enqueued: string[] = []
    const inboxSvc = new InboxService(memoryIdempotencyStore(), async (job) => void enqueued.push(job.payload.messageId))
    const sent = await inboxSvc.sendMessage(fx.ownerCtx, fx.conversationId, 'quota-human-1', 'Ami manually reply korchi!')
    expect(sent.ok).toBe(true) // humans continue
    expect(enqueued).toHaveLength(1)
  })

  it('quotaStatus math: 80% warn level, 100% blocked level', async () => {
    const fx = await fixture('trial')
    const plans = new PlansService()
    const periodKey = DhakaTime.dhakaPeriodKey(new Date())

    await UsageLedger.create({ workspaceId: fx.ws, periodKey, plan: 'trial', conversationsUsed: 80, conversationsLimit: 100 })
    let s = await plans.quotaStatus(fx.ws)
    expect(s.warningLevel).toBe('warn80')
    expect(s.aiPaused).toBe(false)

    await UsageLedger.updateOne({ workspaceId: fx.ws, periodKey }, { $set: { conversationsUsed: 100 } }).exec()
    s = await plans.quotaStatus(fx.ws)
    expect(s.warningLevel).toBe('blocked100')
    expect(s.aiPaused).toBe(true)
  })

  it('warnings emitted at most once per level per period', async () => {
    const fx = await fixture('trial')
    const plans = new PlansService()
    const periodKey = DhakaTime.dhakaPeriodKey(new Date())
    await UsageLedger.create({ workspaceId: fx.ws, periodKey, plan: 'trial', conversationsUsed: 85, conversationsLimit: 100 })

    expect((await plans.maybeWarn(fx.ws)).warned).toBe('80')
    expect((await plans.maybeWarn(fx.ws)).warned).toBe('none') // deduped
    await UsageLedger.updateOne({ workspaceId: fx.ws, periodKey }, { $set: { conversationsUsed: 100 } }).exec()
    expect((await plans.maybeWarn(fx.ws)).warned).toBe('100')
    expect((await plans.maybeWarn(fx.ws)).warned).toBe('none') // deduped
    expect(await OutboxEvent.countDocuments({ workspaceId: fx.ws, type: /quota/ }).exec()).toBe(2)
  })
})

describe('outbox dispatcher (§9 P8 item 3)', () => {
  it('dispatches an email template and marks the row dispatched', async () => {
    const fx = await fixture()
    await OutboxEvent.create({
      workspaceId: fx.ws, type: 'email.invitation',
      payload: { email: 'invitee@x.example', role: 'agent' },
      idempotencyKey: `inv-${Math.random()}`, nextAttemptAt: new Date(),
    })
    const { client, sent } = createMockEmailClient()
    const result = await dispatchOutboxBatch({ email: client })
    expect(result.dispatched).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('invitee@x.example')
    expect(sent[0]!.subject).toContain('invited')
    expect((await OutboxEvent.findOne({ workspaceId: fx.ws }).exec())!.status).toBe('dispatched')
  })

  it('retry ladder 30s/2m/10m then dead after 3 attempts', async () => {
    expect([...EMAIL_RETRY_LADDER_MS]).toEqual([30_000, 120_000, 600_000])
    const fx = await fixture()
    await OutboxEvent.create({
      workspaceId: fx.ws, type: 'email.invitation',
      payload: { email: 'fail@x.example', role: 'agent' },
      idempotencyKey: `fail-${Math.random()}`, nextAttemptAt: new Date(0),
    })
    const failing = { send: async () => { throw new Error('resend 500') } }

    // Attempt 1 → retry at +30 s.
    let r = await dispatchOutboxBatch({ email: failing, now: () => new Date() })
    expect(r.failed).toBe(1)
    let row = await OutboxEvent.findOne({ workspaceId: fx.ws }).exec()
    expect(row!.attempts).toBe(1)
    expect(row!.status).toBe('pending')
    const gap1 = row!.nextAttemptAt.getTime() - Date.now()
    expect(gap1).toBeGreaterThan(25_000)
    expect(gap1).toBeLessThan(35_000)

    // Force due, attempt 2 → +2 m; attempt 3 → dead.
    await OutboxEvent.updateOne({ _id: row!._id }, { $set: { nextAttemptAt: new Date(0) } }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' }).exec()
    r = await dispatchOutboxBatch({ email: failing })
    expect(r.failed).toBe(1)
    await OutboxEvent.updateOne({ _id: row!._id }, { $set: { nextAttemptAt: new Date(0) } }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' }).exec()
    r = await dispatchOutboxBatch({ email: failing })
    expect(r.dead).toBe(1)
    row = await OutboxEvent.findOne({ workspaceId: fx.ws }).exec()
    expect(row!.status).toBe('dead') // the email DLQ
    expect(row!.lastError).toContain('resend 500')
  })

  it('socket fan-out map emits ids+previews only; purge removes old dispatched rows', async () => {
    const fx = await fixture()
    await OutboxEvent.create({
      workspaceId: fx.ws, type: 'order.confirmed',
      payload: { orderId: 'o1', orderCode: 'ORD-2026-00001', conversationId: 'c1', totalMinor: 155900 },
      idempotencyKey: `oc-${Math.random()}`, nextAttemptAt: new Date(),
    })
    const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = []
    const { client } = createMockEmailClient()
    await dispatchOutboxBatch({
      email: client,
      emitSocket: (room, event, payload) => void emitted.push({ room, event, payload }),
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.room).toBe(`ws:${fx.ws}`)
    expect(emitted[0]!.event).toBe('order.updated')
    expect(Object.keys(emitted[0]!.payload).sort()).toEqual(['at', 'orderCode', 'orderId']) // no full docs

    // Purge: dispatched >24h ago disappears.
    await OutboxEvent.updateOne(
      { workspaceId: fx.ws }, { $set: { dispatchedAt: new Date(Date.now() - 2 * DAY_MS) } },
    ).exec()
    expect((await purgeDispatchedOutbox()).purged).toBe(1)
  })
})

describe('usage reconciler (hourly, §13.2)', () => {
  it('recomputes usageLedger from conversations — Mongo is authoritative', async () => {
    const fx = await fixture()
    const periodKey = DhakaTime.dhakaPeriodKey(new Date())
    // 3 billed conversations in Mongo; a drifted ledger claiming 99.
    for (let i = 0; i < 3; i += 1) {
      await Conversation.create({
        workspaceId: fx.ws, channelConnectionId: new mongoose.Types.ObjectId(),
        customerId: new mongoose.Types.ObjectId(), lastMessageAt: new Date(),
        countedForBilling: true, billingPeriodKey: periodKey,
        purgeAfter: new Date(Date.now() + 90 * DAY_MS),
      })
    }
    await UsageLedger.create({ workspaceId: fx.ws, periodKey, plan: 'trial', conversationsUsed: 99, conversationsLimit: 100 })

    const { reconciled } = await reconcileUsage(periodKey)
    expect(reconciled).toBe(1)
    const ledger = await UsageLedger.findOne({ workspaceId: fx.ws, periodKey }).exec()
    expect(ledger!.conversationsUsed).toBe(3) // corrected from the source of truth
    expect(ledger!.reconciledAt).not.toBeNull()
  })
})

describe('nightly stock reconciliation (§6.6 — the oversell detector)', () => {
  it('clean state: no mismatches; drift: reserved≠held and reserved>stock detected', async () => {
    const fx = await fixture()
    const product = await Product.findOne({ workspaceId: fx.ws }).exec()

    // Clean: reserved 2 with a matching held row.
    await Product.updateOne({ _id: product!._id, workspaceId: fx.ws }, { $set: { 'variants.0.reserved': 2 } }).exec()
    await StockReservation.create({
      workspaceId: fx.ws, orderId: new mongoose.Types.ObjectId(), productId: product!._id,
      variantSku: 'JAMA-01-M', qty: 2, status: 'held', expiresAt: new Date(Date.now() + DAY_MS),
    })
    let result = await reconcileStock()
    expect(result.mismatches).toEqual([])

    // Drift: reserved bumped to 4 with only 2 held (a TTL-style leak).
    await Product.updateOne({ _id: product!._id, workspaceId: fx.ws }, { $set: { 'variants.0.reserved': 4 } }).exec()
    result = await reconcileStock()
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({ variantSku: 'JAMA-01-M', reserved: 4, held: 2 })

    // Oversell shape: reserved > stock (5) — also detected.
    await Product.updateOne({ _id: product!._id, workspaceId: fx.ws }, { $set: { 'variants.0.reserved': 9 } }).exec()
    result = await reconcileStock()
    expect(result.mismatches.length).toBeGreaterThan(0)
  })
})

describe('plan change (#72–73)', () => {
  it('non-owner 403; upgrade raises the current-period limit (unblocks AI)', async () => {
    const fx = await fixture('trial')
    const plans = new PlansService()
    const periodKey = DhakaTime.dhakaPeriodKey(new Date())
    await UsageLedger.create({ workspaceId: fx.ws, periodKey, plan: 'trial', conversationsUsed: 100, conversationsLimit: 100 })
    expect((await plans.quotaStatus(fx.ws)).aiPaused).toBe(true)

    const agentCtx = makeTenantContext({ workspaceId: fx.ws, userId: fx.ownerId, role: 'agent', requestId: fakeUlid() })
    const denied = await plans.changePlan(agentCtx, 'starter')
    expect(!denied.ok && denied.error.code).toBe('INSUFFICIENT_PERMISSIONS')

    const upgraded = await plans.changePlan(fx.ownerCtx, 'starter')
    expect(upgraded.ok).toBe(true)
    const after = await plans.quotaStatus(fx.ws)
    expect(after.conversationsLimit).toBe(PLAN_LIMITS['starter']!.conversations)
    expect(after.aiPaused).toBe(false) // upgrade unblocks AI immediately
  })
})
