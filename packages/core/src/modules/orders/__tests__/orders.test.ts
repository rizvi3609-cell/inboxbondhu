/**
 * CP-3 tests — the money phase:
 * - MVP GATE #4: 20 parallel confirmations of the LAST unit → exactly 1
 *   success, 19 BUSINESS_RULE_VIOLATION, reserved == stock after
 * - the client cannot influence totalMinor (Zod strips; service recalculates)
 * - agent discount → 403; 51% → 422 (Zod) and cap → 422 (service)
 * - reservation lifecycle: confirm/cancel/processing/expiry — always paired
 * - state machine: illegal transitions 409; statusHistory appends
 * - abandoned drafts cancelled + released after 24 h
 * - COD split status: Delivered + Unpaid is legal (ADR-008)
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { CreateOrderBody } from '@inboxbondhu/contracts'
import {
  Conversation, Customer, Membership, Order, OutboxEvent, Product, StockReservation, User, Workspace,
  OrdersService, PaymentsService, memoryIdempotencyStore, normaliseZone,
  sweepAbandonedOrders, sweepExpiredReservations,
  FULFILLMENT_TRANSITIONS, canTransitionFulfillment,
} from '../../../index.js'
import { makeTenantContext, type TenantContext } from '../../../kernel/tenantContext.js'
import { dropData, fakeUlid, oid, startDb, stopDb } from '../../../__tests__/setupDb.js'

const DAY_MS = 86_400_000

let svc: OrdersService

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  svc = new OrdersService(memoryIdempotencyStore())
})

interface Fx {
  ws: string
  ownerCtx: TenantContext
  agentCtx: TenantContext
  conversationId: string
  customerId: string
  productId: string
}

async function fixture(stock = 10): Promise<Fx> {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const agent = await User.create({
    ulid: fakeUlid(), email: `a${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Agent Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'Order Fashion', slug: `ord-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: { maxDiscountPercent: 30 },
    deliveryZones: [
      { name: 'Dhaka', feeMinor: 6000, etaDays: 1 },
      { name: 'Outside Dhaka', feeMinor: 12000, etaDays: 3 },
    ],
  })
  await Membership.create([
    { workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() },
    { workspaceId: ws._id, userId: agent._id, role: 'agent', joinedAt: new Date() },
  ])
  const product = await Product.create({
    workspaceId: ws._id, sku: 'JAMA-01', name: 'Cotton Jama', basePriceMinor: 149900,
    variants: [{ sku: 'JAMA-01-M', name: 'M', stock, reserved: 0, isActive: true }],
    status: 'active', searchText: ' ',
  })
  const customer = await Customer.create({
    workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-ord', displayName: 'Order Customer',
    firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
  const conv = await Conversation.create({
    workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
    lastMessageAt: new Date(), purgeAfter: new Date(Date.now() + 90 * DAY_MS),
  })
  return {
    ws: String(ws._id),
    ownerCtx: makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'owner', requestId: fakeUlid() }),
    agentCtx: makeTenantContext({ workspaceId: String(ws._id), userId: String(agent._id), role: 'agent', requestId: fakeUlid() }),
    conversationId: String(conv._id),
    customerId: String(customer._id),
    productId: String(product._id),
  }
}

function orderInput(fx: Fx, quantity = 1, extra: Record<string, unknown> = {}) {
  return {
    conversationId: fx.conversationId,
    customerId: fx.customerId,
    items: [{ productId: fx.productId, variantSku: 'JAMA-01-M', quantity }],
    recipientName: 'Karim Uddin',
    recipientPhone: '01712345678',
    deliveryAddress: 'House 1, Road 2, Dhanmondi',
    deliveryZone: 'Dhaka',
    ...extra,
  }
}

async function createAwaiting(fx: Fx, quantity = 1, key = `k-${Math.random().toString(36).slice(2)}`) {
  const r = await svc.create(fx.ownerCtx, key, orderInput(fx, quantity))
  if (!r.ok) throw r.error
  return r.value.order['id'] as string
}

describe('MVP GATE #4 — the oversell race', () => {
  it('20 parallel confirmations of the last unit → exactly 1 success, 19 × 422, reserved == stock', async () => {
    const fx = await fixture(1) // ONE unit left
    // 20 independent AwaitingConfirmation orders for the same last unit.
    const orderIds: string[] = []
    for (let i = 0; i < 20; i += 1) {
      orderIds.push(await createAwaiting(fx, 1, `race-key-${i}`))
    }

    const results = await Promise.all(orderIds.map((id) => svc.confirm(fx.ownerCtx, id)))
    const successes = results.filter((r) => r.ok)
    const failures = results.filter((r) => !r.ok)

    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(19)
    for (const f of failures) {
      if (!f.ok) expect(f.error.code).toBe('BUSINESS_RULE_VIOLATION') // 422
    }

    const product = await Product.findOne({ _id: fx.productId, workspaceId: fx.ws }).exec()
    const variant = (product!.get('variants') as Array<{ stock: number; reserved: number }>)[0]!
    expect(variant.reserved).toBe(1)
    expect(variant.stock).toBe(1)
    expect(variant.reserved).toBe(variant.stock) // reserved == stock — INV-03 holds

    // Exactly one held reservation; exactly one order got a code.
    expect(await StockReservation.countDocuments({ workspaceId: fx.ws, status: 'held' }).exec()).toBe(1)
    const confirmed = await Order.find({ workspaceId: fx.ws, fulfillmentStatus: 'Confirmed' }).exec()
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0]!.orderCode).toMatch(/^ORD-\d{4}-00001$/)
  }, 120_000)

  it('T1 retry safety: re-confirming an already-confirmed order → 409, no double reservation', async () => {
    const fx = await fixture(5)
    const orderId = await createAwaiting(fx, 2)
    const first = await svc.confirm(fx.ownerCtx, orderId)
    expect(first.ok).toBe(true)
    const second = await svc.confirm(fx.ownerCtx, orderId)
    expect(!second.ok && second.error.code).toBe('INVALID_STATE_TRANSITION')
    expect(await StockReservation.countDocuments({ workspaceId: fx.ws, orderId }).exec()).toBe(1)
    const outbox = await OutboxEvent.countDocuments({ workspaceId: fx.ws, type: 'order.confirmed' }).exec()
    expect(outbox).toBe(1) // idempotencyKey is order-scoped — exactly once
  })
})

describe('money — the server calculates, always (DoD #2)', () => {
  it('the Zod contract STRIPS client-sent totals (strict schema rejects them)', () => {
    const withTotal = CreateOrderBody.safeParse({
      conversationId: oid(), customerId: oid(),
      items: [{ productId: oid(), variantSku: 'V', quantity: 1 }],
      recipientName: 'K', recipientPhone: '01712345678',
      deliveryAddress: 'a', deliveryZone: 'Dhaka',
      totalMinor: 1, // attacker-supplied
    })
    expect(withTotal.success).toBe(false) // strict: unknown key = rejected outright
  })

  it('totals are computed from snapshots: 2 × ৳1499 − 10% + ৳60 delivery', async () => {
    const fx = await fixture()
    const r = await svc.create(fx.ownerCtx, 'money-key-1', orderInput(fx, 2, { discountPercent: 10 }))
    if (!r.ok) throw r.error
    const o = r.value.order
    expect(o['subtotalMinor']).toBe(299800)
    expect(o['discountMinor']).toBe(29980) // floor(299800×10/100)
    expect(o['deliveryFeeMinor']).toBe(6000)
    expect(o['totalMinor']).toBe(299800 - 29980 + 6000)
    const items = o['items'] as Array<{ unitPriceMinor: number; lineTotalMinor: number }>
    expect(items[0]!.unitPriceMinor).toBe(149900) // snapshot
  })

  it('price change AFTER creation does not rewrite the snapshot', async () => {
    const fx = await fixture()
    const orderId = await createAwaiting(fx, 1)
    await Product.updateOne({ _id: fx.productId, workspaceId: fx.ws }, { $set: { basePriceMinor: 999900 } }).exec()
    const fresh = await svc.get(fx.ownerCtx, orderId)
    if (!fresh.ok) throw fresh.error
    const items = fresh.value['items'] as Array<{ unitPriceMinor: number }>
    expect(items[0]!.unitPriceMinor).toBe(149900) // yesterday's order unchanged
  })

  it('zone normalisation: Dkha/dhaka city → Dhaka; unknown → Outside Dhaka', () => {
    const zones = [{ name: 'Dhaka' }, { name: 'Outside Dhaka' }]
    expect(normaliseZone('Dkha', zones)).toBe('Dhaka')
    expect(normaliseZone('dhaka city', zones)).toBe('Dhaka')
    expect(normaliseZone('ঢাকা', zones)).toBe('Dhaka')
    expect(normaliseZone('Rangpur', zones)).toBe('Outside Dhaka')
  })
})

describe('discount carve-outs (DoD #3, #4)', () => {
  it('agent with discountPercent > 0 → 403 INSUFFICIENT_PERMISSIONS', async () => {
    const fx = await fixture()
    const denied = await svc.create(fx.agentCtx, 'agent-disc-1', orderInput(fx, 1, { discountPercent: 5 }))
    expect(!denied.ok && denied.error.code).toBe('INSUFFICIENT_PERMISSIONS')
    // Agent without a discount is fine.
    const allowed = await svc.create(fx.agentCtx, 'agent-disc-2', orderInput(fx, 1))
    expect(allowed.ok).toBe(true)
  })

  it('51% is rejected at the Zod edge; above the workspace cap (30%) → 422 in the service', async () => {
    expect(CreateOrderBody.safeParse({
      ...orderInput(await fixture(), 1), discountPercent: 51,
    }).success).toBe(false) // edge layer

    const fx = await fixture()
    const overCap = await svc.create(fx.ownerCtx, 'cap-key-1', orderInput(fx, 1, { discountPercent: 40 }))
    expect(!overCap.ok && overCap.error.code).toBe('BUSINESS_RULE_VIOLATION') // 422, workspace cap 30
  })
})

describe('idempotency (#60)', () => {
  it('same key twice → one order, replay returns the ORIGINAL with replayed: true', async () => {
    const fx = await fixture()
    const a = await svc.create(fx.ownerCtx, 'idem-order-1', orderInput(fx, 1))
    const b = await svc.create(fx.ownerCtx, 'idem-order-1', orderInput(fx, 3)) // different body, same key
    if (!a.ok || !b.ok) throw new Error('failed')
    expect(b.value.replayed).toBe(true)
    expect(b.value.order['id']).toBe(a.value.order['id'])
    expect(await Order.countDocuments({ workspaceId: fx.ws }).exec()).toBe(1)
  })
})

describe('reservation lifecycle (§11.5)', () => {
  it('cancel before Processing: reserved −qty, row released, stock untouched', async () => {
    const fx = await fixture(10)
    const orderId = await createAwaiting(fx, 3)
    await svc.confirm(fx.ownerCtx, orderId)

    let v = (await Product.findOne({ _id: fx.productId, workspaceId: fx.ws }).exec())!.get('variants') as Array<{ stock: number; reserved: number }>
    expect(v[0]!.reserved).toBe(3)

    const cancelled = await svc.cancel(fx.ownerCtx, orderId, 'customer changed mind')
    expect(cancelled.ok).toBe(true)
    v = (await Product.findOne({ _id: fx.productId, workspaceId: fx.ws }).exec())!.get('variants') as Array<{ stock: number; reserved: number }>
    expect(v[0]!.reserved).toBe(0)
    expect(v[0]!.stock).toBe(10) // stock never fell
    const row = await StockReservation.findOne({ workspaceId: fx.ws, orderId }).exec()
    expect(row!.status).toBe('released')
    expect(row!.releasedAt).not.toBeNull()
  })

  it('Confirmed → Processing commits: reserved −qty AND stock −qty, row committed', async () => {
    const fx = await fixture(10)
    const orderId = await createAwaiting(fx, 4)
    await svc.confirm(fx.ownerCtx, orderId)
    const confirmed = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()

    const r = await svc.update(fx.ownerCtx, orderId, confirmed!.version, { fulfillmentStatus: 'Processing' })
    expect(r.ok).toBe(true)
    const v = (await Product.findOne({ _id: fx.productId, workspaceId: fx.ws }).exec())!.get('variants') as Array<{ stock: number; reserved: number }>
    expect(v[0]!.reserved).toBe(0)
    expect(v[0]!.stock).toBe(6) // permanent decrement
    const row = await StockReservation.findOne({ workspaceId: fx.ws, orderId }).exec()
    expect(row!.status).toBe('committed')
  })

  it('reservationExpirySweeper: expired hold → released + reserved decremented, one transaction', async () => {
    const fx = await fixture(10)
    const orderId = await createAwaiting(fx, 2)
    await svc.confirm(fx.ownerCtx, orderId)
    // Force expiry.
    await StockReservation.updateMany(
      { workspaceId: fx.ws, orderId },
      { $set: { expiresAt: new Date(Date.now() - 60_000) } },
    ).exec()

    const { released } = await sweepExpiredReservations()
    expect(released).toBe(1)
    const v = (await Product.findOne({ _id: fx.productId, workspaceId: fx.ws }).exec())!.get('variants') as Array<{ stock: number; reserved: number }>
    expect(v[0]!.reserved).toBe(0) // both halves happened
    expect((await StockReservation.findOne({ workspaceId: fx.ws, orderId }).exec())!.status).toBe('released')
    // Idempotent: a second sweep finds nothing.
    expect((await sweepExpiredReservations()).released).toBe(0)
  })
})

describe('state machine (§11.1)', () => {
  it('the transition map matches the spec diagram', () => {
    expect(FULFILLMENT_TRANSITIONS['Shipped']).toEqual(['Delivered']) // no cancel after Shipped
    expect(FULFILLMENT_TRANSITIONS['Delivered']).toEqual([])
    expect(canTransitionFulfillment('Processing', 'Cancelled')).toBe(true) // carve-out gated in service
    expect(canTransitionFulfillment('Collecting', 'Confirmed')).toBe(false) // must pass AwaitingConfirmation
  })

  it('illegal transition → 409 INVALID_STATE_TRANSITION, never silent', async () => {
    const fx = await fixture()
    const orderId = await createAwaiting(fx, 1)
    const r = await svc.update(fx.ownerCtx, orderId, 0, { fulfillmentStatus: 'Shipped' }) // Awaiting → Shipped illegal
    expect(!r.ok && r.error.code).toBe('INVALID_STATE_TRANSITION')
  })

  it('Processing → Cancelled: agent 403, owner OK with audited reason', async () => {
    const fx = await fixture(10)
    const orderId = await createAwaiting(fx, 1)
    await svc.confirm(fx.ownerCtx, orderId)
    const confirmed = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    await svc.update(fx.ownerCtx, orderId, confirmed!.version, { fulfillmentStatus: 'Processing' })

    const agentTry = await svc.cancel(fx.agentCtx, orderId, 'fraud suspected')
    expect(!agentTry.ok && agentTry.error.code).toBe('INSUFFICIENT_PERMISSIONS')

    const ownerCancel = await svc.cancel(fx.ownerCtx, orderId, 'fraud confirmed')
    expect(ownerCancel.ok).toBe(true)
    const order = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    expect(order!.cancellationReason).toBe('fraud confirmed')
    // statusHistory appended every step: →Awaiting, →Confirmed, →Processing, →Cancelled.
    expect(order!.statusHistory.length).toBe(4)
  })

  it('COD split status: Delivered + Unpaid simultaneously is LEGAL (ADR-008), then cash → Paid', async () => {
    const fx = await fixture(10)
    const payments = new PaymentsService()
    const orderId = await createAwaiting(fx, 1)
    await svc.confirm(fx.ownerCtx, orderId)
    let o = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    await svc.update(fx.ownerCtx, orderId, o!.version, { fulfillmentStatus: 'Processing' })
    o = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    await svc.update(fx.ownerCtx, orderId, o!.version, { fulfillmentStatus: 'Shipped' })
    o = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    await svc.update(fx.ownerCtx, orderId, o!.version, { fulfillmentStatus: 'Delivered' })

    o = await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec()
    expect(o!.fulfillmentStatus).toBe('Delivered')
    expect(o!.paymentStatus).toBe('Unpaid') // the split — not an inconsistency

    const paid = await payments.recordCodPayment(fx.ownerCtx, orderId, 'CASH-001')
    expect(paid.ok).toBe(true)
    expect((await Order.findOne({ _id: orderId, workspaceId: fx.ws }).exec())!.paymentStatus).toBe('Paid')

    // Shipped/Delivered emitted customer-notify outbox events (PRD §2.9).
    expect(await OutboxEvent.countDocuments({ workspaceId: fx.ws, type: 'order.shipped' }).exec()).toBe(1)
    expect(await OutboxEvent.countDocuments({ workspaceId: fx.ws, type: 'order.delivered' }).exec()).toBe(1)
  })

  it('payment against a cancelled order is rejected (PRD §2.10)', async () => {
    const fx = await fixture()
    const payments = new PaymentsService()
    const orderId = await createAwaiting(fx, 1)
    await svc.cancel(fx.ownerCtx, orderId, 'test cancel')
    const r = await payments.recordCodPayment(fx.ownerCtx, orderId)
    expect(!r.ok && r.error.code).toBe('INVALID_STATE_TRANSITION')
  })
})

describe('abandoned drafts (DoD #5)', () => {
  it('a Collecting draft untouched 24 h is cancelled and any stock released', async () => {
    const fx = await fixture(10)
    // A Collecting draft (conversational capture path).
    const draft = await Order.create({
      workspaceId: fx.ws, conversationId: fx.conversationId, customerId: fx.customerId,
      items: [{ productId: fx.productId, variantSku: 'JAMA-01-M', nameSnapshot: 'Cotton Jama', variantNameSnapshot: 'M', unitPriceMinor: 149900, quantity: 1, lineTotalMinor: 149900 }],
      subtotalMinor: 149900, discountMinor: 0, deliveryFeeMinor: 0, totalMinor: 149900,
      deliveryZone: 'Dhaka', deliveryAddress: 'pending', recipientName: 'pending', recipientPhone: '01712345678',
      fulfillmentStatus: 'Collecting', createdByType: 'ai',
      draftLastTouchedAt: new Date(Date.now() - 25 * 3_600_000), // 25 h stale
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })
    const freshDraft = await Order.create({
      workspaceId: fx.ws, conversationId: fx.conversationId, customerId: fx.customerId,
      items: [{ productId: fx.productId, variantSku: 'JAMA-01-M', nameSnapshot: 'Cotton Jama', variantNameSnapshot: 'M', unitPriceMinor: 149900, quantity: 1, lineTotalMinor: 149900 }],
      subtotalMinor: 149900, discountMinor: 0, deliveryFeeMinor: 0, totalMinor: 149900,
      deliveryZone: 'Dhaka', deliveryAddress: 'pending', recipientName: 'pending', recipientPhone: '01712345678',
      fulfillmentStatus: 'Collecting', createdByType: 'ai',
      draftLastTouchedAt: new Date(), // fresh
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })

    const { cancelled } = await sweepAbandonedOrders(24)
    expect(cancelled).toBe(1)
    expect((await Order.findOne({ _id: draft._id, workspaceId: fx.ws }).exec())!.fulfillmentStatus).toBe('Cancelled')
    expect((await Order.findOne({ _id: draft._id, workspaceId: fx.ws }).exec())!.cancellationReason).toBe('system_abandoned')
    expect((await Order.findOne({ _id: freshDraft._id, workspaceId: fx.ws }).exec())!.fulfillmentStatus).toBe('Collecting')
  })
})

describe('order numbers', () => {
  it('sequential codes per workspace-year; drafts have none until confirm', async () => {
    const fx = await fixture(10)
    const id1 = await createAwaiting(fx, 1)
    const id2 = await createAwaiting(fx, 1)
    // Before confirm: no code.
    expect((await Order.findOne({ _id: id1, workspaceId: fx.ws }).exec())!.orderCode).toBeNull()
    await svc.confirm(fx.ownerCtx, id1)
    await svc.confirm(fx.ownerCtx, id2)
    const codes = (await Order.find({ workspaceId: fx.ws, fulfillmentStatus: 'Confirmed' }).exec())
      .map((o) => o.orderCode).sort()
    expect(codes).toEqual([`ORD-${new Date().getFullYear()}-00001`, `ORD-${new Date().getFullYear()}-00002`])
  })
})

describe('payments service', () => {
  it('providers: COD enabled, others comingSoon; payment-link → 501', () => {
    const payments = new PaymentsService()
    const providers = payments.providers()
    expect(providers.ok && providers.value).toEqual([
      { id: 'cod', enabled: true, comingSoon: false },
      { id: 'bkash', enabled: false, comingSoon: true },
      { id: 'nagad', enabled: false, comingSoon: true },
      { id: 'rocket', enabled: false, comingSoon: true },
    ])
    const link = payments.paymentLink()
    expect(!link.ok && link.error.code).toBe('NOT_IMPLEMENTED')
  })
})
