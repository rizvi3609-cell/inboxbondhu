/**
 * Model round-trip + trap-note tests for the Phase 1 DoD:
 * - all 19 models round-trip
 * - custom validators for the DB-unenforceable single-document rules
 * - orderCounter $inc pattern, year-scoped
 * - unique indexes behave (I18 global, I21 3-field, I29 partial-unique, I48 global)
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import {
  AuditLog, ChannelConnection, Conversation, Customer, Import, Invitation, KnowledgeItem,
  Membership, Message, Order, OrderCounter, OutboxEvent, Product, Session, StockReservation,
  UsageLedger, User, WebhookEvent, Workspace, nextOrderCode, createIndexes, withTx,
} from '../db/index.js'
import { dropData, fakeUlid, oid, sha256ish, startDb, stopDb } from './setupDb.js'

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

const ws = oid()

describe('users — trap notes', () => {
  it('passwordHash has select:false — not returned by default', async () => {
    await User.create({ ulid: fakeUlid(), email: 'a@b.co', passwordHash: 'argon2id$x', name: 'Test A' })
    const found = await User.findOne({ email: 'a@b.co' }).exec()
    expect(found).not.toBeNull()
    expect((found as unknown as { passwordHash?: string }).passwordHash).toBeUndefined()
    const withHash = await User.findOne({ email: 'a@b.co' }).select('+passwordHash').exec()
    expect((withHash as unknown as { passwordHash?: string }).passwordHash).toBe('argon2id$x')
  })

  it('email is normalised (lowercase + trim) in the pre-validate hook', async () => {
    const u = await User.create({
      ulid: fakeUlid(),
      email: '  MiXeD@ExAmPle.COM ',
      passwordHash: 'h',
      name: 'Mixed Case',
    })
    expect(u.email).toBe('mixed@example.com')
  })

  it('failedLoginCount defaults to 0 and is a plain counter (cumulative semantics live in Phase 2)', async () => {
    const u = await User.create({ ulid: fakeUlid(), email: 'c@d.co', passwordHash: 'h', name: 'Cnt' })
    expect(u.failedLoginCount).toBe(0)
  })
})

describe('memberships — tombstone uniqueness (I12 partial)', () => {
  it('blocks double active membership but allows re-invite after removal', async () => {
    const userId = oid()
    await Membership.create({ workspaceId: ws, userId, role: 'agent', joinedAt: new Date() })
    await expect(
      Membership.create({ workspaceId: ws, userId, role: 'viewer', joinedAt: new Date() }),
    ).rejects.toThrow(/E11000/)

    // Tombstone, then re-invite works.
    await Membership.updateOne({ workspaceId: ws, userId }, { $set: { removedAt: new Date() } }).exec()
    await expect(
      Membership.create({ workspaceId: ws, userId, role: 'agent', joinedAt: new Date() }),
    ).resolves.toBeDefined()
  })
})

describe('invitations — role can never be owner', () => {
  it('rejects role: owner at the schema layer', async () => {
    await expect(
      Invitation.create({
        workspaceId: ws,
        email: 'x@y.co',
        role: 'owner',
        tokenHash: sha256ish('t'),
        invitedBy: oid(),
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      }),
    ).rejects.toThrow()
  })
})

describe('channelConnections — ADR-013 global uniqueness', () => {
  function conn(workspaceId: string, pageId: string) {
    return {
      workspaceId,
      provider: 'facebook' as const,
      externalPageId: pageId,
      pageName: 'Test Page',
      accessTokenCipher: 'cipher',
      accessTokenIv: 'aXZpdml2aXZpdg==',
      accessTokenTag: 'dGFnZ3RhZ2d0YWdndGFnZw==',
      connectedBy: oid(),
    }
  }

  it('a second workspace claiming the same page gets E11000 (the "already connected" error)', async () => {
    await ChannelConnection.create(conn(ws, 'page-777'))
    await expect(ChannelConnection.create(conn(oid(), 'page-777'))).rejects.toThrow(/E11000/)
  })
})

describe('customers — 3-field key (DB-03)', () => {
  it('same externalUserId under different providers does NOT collide', async () => {
    const base = {
      workspaceId: ws,
      externalUserId: '424242',
      displayName: 'Same Number',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }
    await Customer.create({ ...base, provider: 'facebook' })
    await expect(Customer.create({ ...base, provider: 'instagram' })).resolves.toBeDefined()
    await expect(Customer.create({ ...base, provider: 'facebook' })).rejects.toThrow(/E11000/)
  })
})

describe('messages — traps', () => {
  const convId = oid()
  function msg(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId: ws,
      conversationId: convId,
      direction: 'inbound',
      author: { type: 'customer' },
      contentType: 'text',
      text: 'dam koto?',
      ...overrides,
    }
  }

  it('author.userId required iff author.type=agent (rule #8)', async () => {
    await expect(Message.create(msg({ author: { type: 'agent' } }))).rejects.toThrow(/author\.userId/)
    await expect(
      Message.create(msg({ direction: 'outbound', author: { type: 'agent', userId: oid() } })),
    ).resolves.toBeDefined()
    await expect(Message.create(msg({ author: { type: 'customer', userId: oid() } }))).rejects.toThrow(
      /author\.userId/,
    )
  })

  it('providerMessageId dedupe: duplicate MID in one workspace collides; null MIDs never do', async () => {
    await Message.create(msg({ providerMessageId: 'mid_1' }))
    await expect(Message.create(msg({ providerMessageId: 'mid_1' }))).rejects.toThrow(/E11000/)
    // Two nulls (queued outbound) must NOT collide.
    await Message.create(msg({ direction: 'outbound', author: { type: 'ai' } }))
    await expect(
      Message.create(msg({ direction: 'outbound', author: { type: 'ai' } })),
    ).resolves.toBeDefined()
  })
})

describe('products — derived searchText + variant integrity', () => {
  it('regenerates searchText in the pre-save hook', async () => {
    const p = await Product.create({
      workspaceId: ws,
      sku: 'JAMA-01',
      name: 'Cotton Jama',
      description: 'Comfortable summer jama',
      basePriceMinor: 129900,
      variants: [{ sku: 'JAMA-01-R-M', name: 'Red / M', stock: 10 }],
    })
    expect(p.searchText).toContain('Cotton Jama')
    expect(p.searchText).toContain('JAMA-01-R-M')
  })

  it('rejects duplicate variant skus within one product', async () => {
    await expect(
      Product.create({
        workspaceId: ws,
        sku: 'DUP-01',
        name: 'Dup variant',
        basePriceMinor: 1000,
        variants: [
          { sku: 'V1', name: 'A', stock: 1 },
          { sku: 'V1', name: 'B', stock: 2 },
        ],
      }),
    ).rejects.toThrow(/unique within the parent/)
  })

  it('requires at least one variant', async () => {
    await expect(
      Product.create({ workspaceId: ws, sku: 'NOVAR', name: 'No variants', basePriceMinor: 1, variants: [] }),
    ).rejects.toThrow()
  })
})

describe('orders — orderCode regex + counters', () => {
  it('rejects a malformed orderCode (custom validator, rule set §5.8)', async () => {
    await expect(
      Order.create({
        workspaceId: ws,
        orderNumber: 1,
        orderYear: 2026,
        orderCode: 'ORD-26-1', // bad
        conversationId: oid(),
        customerId: oid(),
        items: [{ productId: oid(), variantSku: 'V', nameSnapshot: 'N', variantNameSnapshot: 'VN', unitPriceMinor: 100, quantity: 1, lineTotalMinor: 100 }],
        subtotalMinor: 100,
        totalMinor: 100,
        deliveryZone: 'Dhaka',
        deliveryAddress: 'addr',
        recipientName: 'R',
        recipientPhone: '01712345678',
        createdByType: 'ai',
        purgeAfter: new Date(),
      }),
    ).rejects.toThrow()
  })

  it('nextOrderCode: atomic $inc, year-scoped, zero-padded', async () => {
    const a = await nextOrderCode(ws, 2026)
    const b = await nextOrderCode(ws, 2026)
    const c = await nextOrderCode(ws, 2027)
    expect(a).toEqual({ orderNumber: 1, orderCode: 'ORD-2026-00001' })
    expect(b).toEqual({ orderNumber: 2, orderCode: 'ORD-2026-00002' })
    // Year-scoped: 2027 restarts at 1 (DB-01).
    expect(c).toEqual({ orderNumber: 1, orderCode: 'ORD-2027-00001' })
  })

  it('nextOrderCode is race-safe: 20 concurrent calls yield 20 distinct numbers', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => nextOrderCode(ws, 2026)))
    const numbers = new Set(results.map((r) => r.orderNumber))
    expect(numbers.size).toBe(20)
    const counter = await OrderCounter.findOne({ _id: `${ws}:2026`, workspaceId: ws }).exec()
    expect(counter!.seq).toBe(20)
  })

  it('statusHistory appends and orderYear/orderCode are immutable', async () => {
    const order = await Order.create({
      workspaceId: ws,
      orderNumber: 9,
      orderYear: 2026,
      orderCode: 'ORD-2026-00009',
      conversationId: oid(),
      customerId: oid(),
      items: [{ productId: oid(), variantSku: 'V', nameSnapshot: 'N', variantNameSnapshot: 'VN', unitPriceMinor: 100, quantity: 1, lineTotalMinor: 100 }],
      subtotalMinor: 100,
      totalMinor: 100,
      deliveryZone: 'Dhaka',
      deliveryAddress: 'addr',
      recipientName: 'R',
      recipientPhone: '01712345678',
      createdByType: 'agent',
      purgeAfter: new Date(Date.now() + 90 * 86400_000),
    })
    // immutable + strict:'throw' → mutating orderYear fails validation at save
    const tampered = await Order.findOne({ _id: order._id, workspaceId: ws }).exec()
    tampered!.set('orderYear', 2030)
    await expect(tampered!.save()).rejects.toThrow(/immutable/)

    order.statusHistory.push({ from: 'Collecting', to: 'AwaitingConfirmation', at: new Date(), byType: 'agent', byUserId: oid() } as never)
    await order.save()
    const fresh = await Order.findOne({ _id: order._id, workspaceId: ws }).exec()
    expect(fresh!.orderYear).toBe(2026)
    expect(fresh!.statusHistory).toHaveLength(1)
  })
})

describe('stockReservations — DB-07', () => {
  it('has NO TTL index on expiresAt', () => {
    const ttl = StockReservation.schema
      .indexes()
      .filter(([, opts]) => (opts as { expireAfterSeconds?: number }).expireAfterSeconds !== undefined)
    expect(ttl).toHaveLength(0)
  })
})

describe('webhookEvents — dedupe traps', () => {
  it('dedupeKey is plaintext {provider}:{pageId}:{mid} and globally unique (I48)', async () => {
    const doc = {
      provider: 'facebook' as const,
      externalPageId: '107812',
      dedupeKey: 'facebook:107812:mid_AbC123',
      signatureValid: true,
      rawPayload: { object: 'page' },
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    }
    await WebhookEvent.create(doc)
    // The >24h redelivery path: Redis gate passed, I48 catches it. Treat as dedupe.
    let dedupedByIndex = false
    try {
      await WebhookEvent.create(doc)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) dedupedByIndex = true
    }
    expect(dedupedByIndex).toBe(true)
  })
})

describe('outboxEvents — exactly-once key', () => {
  it('idempotencyKey is globally unique (I52)', async () => {
    const base = {
      workspaceId: ws,
      type: 'email.verification',
      payload: { to: 'x@y.co' },
      idempotencyKey: 'email.verification:user1',
      nextAttemptAt: new Date(),
    }
    await OutboxEvent.create(base)
    await expect(OutboxEvent.create({ ...base, workspaceId: oid() })).rejects.toThrow(/E11000/)
  })
})

describe('workspaces — constants and validators', () => {
  function wsInput(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Rupa Fashion',
      slug: 'rupa-fashion',
      ownerId: oid(),
      businessHours: {
        enabled: false,
        days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })),
      },
      aiConfig: {},
      ...overrides,
    }
  }

  it('7-day businessHours rule rejects 6 entries', async () => {
    const input = wsInput()
    ;(input.businessHours as { days: unknown[] }).days = (input.businessHours as { days: unknown[] }).days.slice(0, 6)
    await expect(Workspace.create(input)).rejects.toThrow(/exactly 7/)
  })

  it('maxDiscountPercent caps at 50 (DB layer of the 3-layer control)', async () => {
    await expect(
      Workspace.create(wsInput({ slug: 'rupa-2', aiConfig: { maxDiscountPercent: 60 } })),
    ).rejects.toThrow()
  })

  it('timezone/currency/language are constants but stored', async () => {
    const w = await Workspace.create(wsInput({ slug: 'rupa-3' }))
    expect(w.timezone).toBe('Asia/Dhaka')
    expect(w.currency).toBe('BDT')
    expect(w.language).toBe('bn-en')
  })
})

describe('remaining collections round-trip', () => {
  it('conversations, knowledgeItems, usageLedger, auditLogs, imports, sessions', async () => {
    const conv = await Conversation.create({
      workspaceId: ws,
      channelConnectionId: oid(),
      customerId: oid(),
      lastMessageAt: new Date(),
      purgeAfter: new Date(Date.now() + 90 * 86400_000),
    })
    expect(conv.mode).toBe('ai')
    expect(conv.countedForBilling).toBe(false)

    const ki = await KnowledgeItem.create({
      workspaceId: ws,
      question: 'Delivery charge koto?',
      answer: 'Dhaka te 60 taka, baire 120 taka.',
      keywords: ['Delivery', 'CHARGE'],
    })
    expect(ki.status).toBe('draft') // AI reads approved only
    expect(ki.keywords).toEqual(['delivery', 'charge']) // lowercased
    expect(ki.searchText).toContain('Delivery charge koto?')

    const ledger = await UsageLedger.create({
      workspaceId: ws,
      periodKey: '2026-08',
      plan: 'trial',
      conversationsLimit: 100,
    })
    expect(ledger.conversationsUsed).toBe(0)

    const audit = await AuditLog.create({
      workspaceId: ws,
      actorId: 'system',
      actorType: 'system',
      action: 'workspace.created',
      resourceType: 'workspace',
      resourceId: ws,
      requestId: fakeUlid(),
    })
    expect(audit.actorRole).toBeNull()

    const imp = await Import.create({
      workspaceId: ws,
      type: 'products_csv',
      fileName: 'products.csv',
      spacesKey: `${ws}/imports/x.csv`,
      totalRows: 100,
      createdBy: oid(),
    })
    expect(imp.lastProcessedRow).toBe(0)

    const session = await Session.create({
      userId: oid(),
      familyId: fakeUlid(),
      refreshTokenHash: sha256ish('rt'),
      userAgent: 'vitest',
      ipHash: sha256ish('ip'),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86400_000),
    })
    expect(session.generation).toBe(0)
  })
})

describe('withTx — transactions work on the memory replica set', () => {
  it('commits a multi-document write atomically', async () => {
    await withTx(async (session) => {
      await OrderCounter.findOneAndUpdate(
        { _id: `${ws}:2026`, workspaceId: ws },
        { $inc: { seq: 1 }, $setOnInsert: { year: 2026 }, $set: { updatedAt: new Date() } },
        { upsert: true, new: true, session },
      )
      await AuditLog.create(
        [
          {
            workspaceId: ws,
            actorId: 'system',
            actorType: 'system',
            action: 'order.numbered',
            resourceType: 'orderCounter',
            resourceId: `${ws}:2026`,
            requestId: fakeUlid(),
          },
        ],
        { session },
      )
    })
    const counter = await OrderCounter.findOne({ _id: `${ws}:2026`, workspaceId: ws }).exec()
    expect(counter!.seq).toBe(1)
  })

  it('rolls back everything when the callback throws', async () => {
    await expect(
      withTx(async (session) => {
        await OrderCounter.findOneAndUpdate(
          { _id: `${ws}:2030`, workspaceId: ws },
          { $inc: { seq: 1 }, $setOnInsert: { year: 2030 }, $set: { updatedAt: new Date() } },
          { upsert: true, new: true, session },
        )
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const counter = await OrderCounter.findOne({ _id: `${ws}:2030`, workspaceId: ws }).exec()
    expect(counter).toBeNull()
  })
})

describe('oversell guard shape (T1 $expr filter) — the pattern Phase 7 must copy', () => {
  it('20 parallel reservations of the last unit → exactly 1 success, reserved == stock', async () => {
    const p = await Product.create({
      workspaceId: ws,
      sku: 'LAST-01',
      name: 'Last unit',
      basePriceMinor: 5000,
      status: 'active',
      variants: [{ sku: 'LAST-01-V', name: 'Only', stock: 1, reserved: 0 }],
    })

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        Product.updateOne(
          {
            _id: p._id,
            workspaceId: ws,
            variants: { $elemMatch: { sku: 'LAST-01-V' } },
            $expr: {
              $anyElementTrue: {
                $map: {
                  input: '$variants',
                  as: 'v',
                  in: {
                    $and: [
                      { $eq: ['$$v.sku', 'LAST-01-V'] },
                      { $gte: [{ $subtract: ['$$v.stock', '$$v.reserved'] }, 1] },
                    ],
                  },
                },
              },
            },
          },
          { $inc: { 'variants.$.reserved': 1 } },
        ).exec(),
      ),
    )
    const successes = attempts.filter((r) => r.modifiedCount === 1).length
    expect(successes).toBe(1)
    const fresh = await Product.findOne({ _id: p._id, workspaceId: ws }).exec()
    expect(fresh!.variants[0]!.reserved).toBe(1)
    expect(fresh!.variants[0]!.reserved).toBeLessThanOrEqual(fresh!.variants[0]!.stock)
  })
})

describe('mongoose strict mode', () => {
  it('unknown fields throw rather than silently drop', async () => {
    await expect(
      Customer.create({
        workspaceId: ws,
        provider: 'facebook',
        externalUserId: 'x1',
        displayName: 'X',
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        totallyUnknownField: 1,
      } as never),
    ).rejects.toThrow()
  })
})
