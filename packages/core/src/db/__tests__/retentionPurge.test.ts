/**
 * P-11 — the retention purger is resumable and idempotent (§16.1 row 13):
 * interrupt mid-run and re-run → no orphans, no double-deletes. Plus the
 * §15.2 anonymisation contract: phone/address cleared, phoneHash SURVIVES,
 * name becomes "Deleted Customer #hash".
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  AuditLog, Conversation, Customer, Import,
  KnowledgeItem, Membership, Message, Order, Product,
  StockReservation, User, Workspace,
  runRetentionPurge,
} from '../../index.js'
import { dropData, startDb, stopDb } from '../../__tests__/setupDb.js'

const DAY_MS = 86_400_000
const BYPASS = { skipTenancy: true, tenancyBypassCaller: 'adminReporting' } as const
const past = new Date(Date.now() - DAY_MS)
const future = new Date(Date.now() + 90 * DAY_MS)

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

async function seedDeadWorkspace(msgCount = 5): Promise<{ ws: mongoose.Types.ObjectId }> {
  const owner = await User.create({
    ulid: '0'.repeat(26), email: `dead-${Date.now()}@x.example`, passwordHash: 'h', name: 'Dead Owner',
  })
  const ws = await Workspace.create({
    name: 'Dead Shop', slug: `dead-${Date.now()}`, ownerId: owner._id,
    status: 'deactivated', deactivatedAt: past, purgeAfter: past,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
  })
  const wsId = ws._id
  await Membership.create({ workspaceId: wsId, userId: owner._id, role: 'owner', joinedAt: past })
  const customer = await Customer.create({
    workspaceId: wsId, provider: 'facebook', externalUserId: 'psid-dead', displayName: 'C',
    firstSeenAt: past, lastSeenAt: past,
  })
  const conv = await Conversation.create({
    workspaceId: wsId, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
    lastMessageAt: past, purgeAfter: future, // future — the CASCADE must still take it
  })
  for (let i = 0; i < msgCount; i += 1) {
    await Message.create({
      workspaceId: wsId, conversationId: conv._id, direction: 'inbound',
      author: { type: 'customer' }, contentType: 'text', text: `m${i}`, status: 'delivered',
    })
  }
  const product = await Product.create({
    workspaceId: wsId, sku: 'DEAD-01', name: 'Dead product', basePriceMinor: 100_00,
    variants: [{ sku: 'DEAD-01-M', name: 'M', stock: 5, reserved: 0, isActive: true }],
    status: 'active', searchText: ' ',
  })
  const order = await Order.create({
    workspaceId: wsId, conversationId: conv._id, customerId: customer._id,
    items: [{ productId: product._id, variantSku: 'DEAD-01-M', nameSnapshot: 'Dead product',
      variantNameSnapshot: 'M', unitPriceMinor: 100_00, quantity: 1, lineTotalMinor: 100_00 }],
    subtotalMinor: 100_00, totalMinor: 100_00, deliveryZone: 'Dhaka',
    deliveryAddress: 'House 1, Dhanmondi', recipientName: 'C', recipientPhone: '01712345678',
    createdByType: 'agent', purgeAfter: future,
  })
  await StockReservation.create({
    workspaceId: wsId, orderId: order._id, productId: product._id, variantSku: 'DEAD-01-M',
    qty: 1, status: 'held', expiresAt: future,
  })
  await KnowledgeItem.create({
    workspaceId: wsId, question: 'Dead question?', answer: 'Dead answer here.', searchText: ' ',
  })
  await Import.create({
    workspaceId: wsId, type: 'products_csv', createdBy: owner._id,
    fileName: 'x.csv', spacesKey: 'inline:', totalRows: 0, status: 'completed',
  })
  await AuditLog.create({
    workspaceId: wsId, actorId: 'system', actorType: 'system', actorRole: null,
    action: 'workspace.seeded', resourceType: 'workspace', resourceId: String(wsId), requestId: '0'.repeat(26),
  })
  return { ws: wsId }
}

async function countAll(wsId: mongoose.Types.ObjectId): Promise<number> {
  const filters = { workspaceId: wsId }
  const counts = await Promise.all([
    Message.countDocuments(filters).setOptions(BYPASS).exec(),
    Conversation.countDocuments(filters).setOptions(BYPASS).exec(),
    Order.countDocuments(filters).setOptions(BYPASS).exec(),
    StockReservation.countDocuments(filters).setOptions(BYPASS).exec(),
    Customer.countDocuments(filters).setOptions(BYPASS).exec(),
    Product.countDocuments(filters).setOptions(BYPASS).exec(),
    KnowledgeItem.countDocuments(filters).setOptions(BYPASS).exec(),
    Import.countDocuments(filters).setOptions(BYPASS).exec(),
    AuditLog.countDocuments(filters).setOptions(BYPASS).exec(),
    Membership.countDocuments(filters).setOptions(BYPASS).exec(),
    Workspace.countDocuments({ _id: wsId }).exec(),
  ])
  return counts.reduce((a, b) => a + b, 0)
}

describe('retentionPurger — P-11', () => {
  it('purges a dead workspace completely: every tenant row + the workspace doc', async () => {
    const { ws } = await seedDeadWorkspace()
    expect(await countAll(ws)).toBeGreaterThan(10)

    const report = await runRetentionPurge()

    expect(report.workspacesPurged).toBe(1)
    expect(await countAll(ws)).toBe(0) // NOTHING dangling
  })

  it('INTERRUPTED mid-cascade and re-run → no orphans, no double-deletes', async () => {
    const { ws } = await seedDeadWorkspace(12)

    // Crash injection: batchSize 3 → messages need 4 batches; kill after 2.
    let batches = 0
    await expect(
      runRetentionPurge({
        batchSize: 3,
        onBatch: () => {
          batches += 1
          if (batches === 2) throw new Error('simulated crash mid-purge')
        },
      }),
    ).rejects.toThrow('simulated crash')

    // Mid-state: some messages gone, conversation still present — the phase
    // order guarantees no message ever points at a purged conversation.
    const midMessages = await Message.countDocuments({ workspaceId: ws }).setOptions(BYPASS).exec()
    expect(midMessages).toBeGreaterThan(0)
    expect(midMessages).toBeLessThan(12)
    expect(await Conversation.countDocuments({ workspaceId: ws }).setOptions(BYPASS).exec()).toBe(1)
    expect(await Workspace.countDocuments({ _id: ws }).exec()).toBe(1)

    // Re-run — finds exactly the remainder, finishes clean.
    const report = await runRetentionPurge({ batchSize: 3 })
    expect(report.workspacesPurged).toBe(1)
    expect(await countAll(ws)).toBe(0)

    // Idempotent: a THIRD run deletes nothing.
    const again = await runRetentionPurge({ batchSize: 3 })
    expect(again.workspacesPurged).toBe(0)
    expect(again.messagesPurged).toBe(0)
  })

  it('a maxBatches-bounded run RESUMES next day without the workspace doc going early', async () => {
    const { ws } = await seedDeadWorkspace(10)
    const first = await runRetentionPurge({ batchSize: 2, maxBatches: 3 })
    expect(first.workspacesPurged).toBe(0) // budget ran out before the last phase
    expect(await Workspace.countDocuments({ _id: ws }).exec()).toBe(1) // parent still there
    const second = await runRetentionPurge({ batchSize: 500 })
    expect(second.workspacesPurged).toBe(1)
    expect(await countAll(ws)).toBe(0)
  })

  it('row-level retention in a LIVE workspace: conversations+messages and orders+reservations past purgeAfter', async () => {
    const owner = await User.create({ ulid: '1'.repeat(26), email: 'live@x.example', passwordHash: 'h', name: 'Live Owner' })
    const ws = await Workspace.create({ name: 'Live Shop', slug: 'live-shop', ownerId: owner._id, businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) } })
    const customer = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-live', displayName: 'L',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    })
    const oldConv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
      lastMessageAt: past, purgeAfter: past, // EXPIRED
    })
    const freshConv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
      lastMessageAt: new Date(), purgeAfter: future, // NOT expired
    })
    await Message.create({
      workspaceId: ws._id, conversationId: oldConv._id, direction: 'inbound',
      author: { type: 'customer' }, contentType: 'text', text: 'old', status: 'delivered',
    })
    await Message.create({
      workspaceId: ws._id, conversationId: freshConv._id, direction: 'inbound',
      author: { type: 'customer' }, contentType: 'text', text: 'fresh', status: 'delivered',
    })
    const product = await Product.create({
      workspaceId: ws._id, sku: 'LIVE-01', name: 'Live product', basePriceMinor: 100_00,
      variants: [{ sku: 'LIVE-01-M', name: 'M', stock: 5, reserved: 0, isActive: true }],
      status: 'active', searchText: ' ',
    })
    const oldOrder = await Order.create({
      workspaceId: ws._id, conversationId: oldConv._id, customerId: customer._id,
      items: [{ productId: product._id, variantSku: 'LIVE-01-M', nameSnapshot: 'Live product',
        variantNameSnapshot: 'M', unitPriceMinor: 100_00, quantity: 1, lineTotalMinor: 100_00 }],
      subtotalMinor: 100_00, totalMinor: 100_00, deliveryZone: 'Dhaka',
      deliveryAddress: 'Addr', recipientName: 'L', recipientPhone: '01812345678',
      createdByType: 'agent', purgeAfter: past, // EXPIRED
    })
    await StockReservation.create({
      workspaceId: ws._id, orderId: oldOrder._id, productId: product._id, variantSku: 'LIVE-01-M',
      qty: 1, status: 'released', expiresAt: past,
    })

    const report = await runRetentionPurge()

    expect(report.conversationsPurged).toBe(1)
    expect(report.messagesPurged).toBe(1)
    expect(report.ordersPurged).toBe(1)
    expect(report.reservationsPurged).toBe(1)
    // The live rows survive; the workspace itself is untouched.
    expect(await Conversation.countDocuments({ workspaceId: ws._id }).setOptions(BYPASS).exec()).toBe(1)
    expect(await Message.countDocuments({ workspaceId: ws._id }).setOptions(BYPASS).exec()).toBe(1)
    expect(await Workspace.countDocuments({ _id: ws._id }).exec()).toBe(1)
  })

  it('anonymises stale customers per §15.2: phone/address cleared, phoneHash SURVIVES, name replaced', async () => {
    const owner = await User.create({ ulid: '2'.repeat(26), email: 'anon@x.example', passwordHash: 'h', name: 'Anon Owner' })
    const ws = await Workspace.create({ name: 'Anon Shop', slug: 'anon-shop', ownerId: owner._id, businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) } })
    const phoneHash = 'a'.repeat(64)
    const stale = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-old', displayName: 'Rahima Khatun',
      phone: '01912345678', phoneHash, addressText: 'House 7, Mirpur', notes: 'repeat buyer',
      orderCount: 3, totalSpentMinor: 4500_00,
      firstSeenAt: new Date(Date.now() - 200 * DAY_MS), lastSeenAt: new Date(Date.now() - 120 * DAY_MS),
    })
    const active = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-new', displayName: 'Karim',
      phone: '01712340000', firstSeenAt: new Date(), lastSeenAt: new Date(),
    })

    const report = await runRetentionPurge()
    expect(report.customersAnonymised).toBe(1)

    const anon = await Customer.findOne({ _id: stale._id, workspaceId: ws._id }).exec()
    expect(anon).not.toBeNull()
    expect(anon!.displayName).toMatch(/^Deleted Customer #[0-9a-f]{8}$/)
    expect(anon!.phone).toBeNull()
    expect(anon!.addressText).toBeNull()
    expect(anon!.notes).toBeNull()
    expect(anon!.phoneHash).toBe(phoneHash) // SURVIVES — repeat-customer/fraud logic
    expect(anon!.orderCount).toBe(3) // history intact
    expect(anon!.anonymizedAt).not.toBeNull()

    // Re-run: the anonymizedAt guard makes it a no-op (no double-anonymise).
    const again = await runRetentionPurge()
    expect(again.customersAnonymised).toBe(0)

    const untouched = await Customer.findOne({ _id: active._id, workspaceId: ws._id }).exec()
    expect(untouched!.displayName).toBe('Karim')
    expect(untouched!.phone).toBe('01712340000')
  })

  it('does not purge a user who still owns a workspace', async () => {
    const owner = await User.create({
      ulid: '3'.repeat(26), email: 'stillowner@x.example', passwordHash: 'h', name: 'Owner Two',
      status: 'pending_deletion', purgeAfter: past,
    })
    await Workspace.create({ name: 'Owned', slug: 'still-owned', ownerId: owner._id, businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) } })
    const report = await runRetentionPurge()
    expect(report.usersPurged).toBe(0)
    expect(await User.countDocuments({ _id: owner._id }).exec()).toBe(1)
  })
})
