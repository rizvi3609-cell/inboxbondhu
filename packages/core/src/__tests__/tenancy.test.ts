/**
 * Tenancy plugin tests — WRITTEN FIRST (prompt.md §9 Phase 1 item 2).
 * The single highest-severity bug class in the system:
 *  - a forgotten workspaceId filter THROWS (never returns cross-tenant data)
 *  - each of the four bypasses works only with skipTenancy: true
 *  - exempt collections (users, sessions, webhookEvents) are not guarded
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  Conversation, Customer, Membership, Message, Order, Product, User, Session, WebhookEvent,
  TenantScopeViolationError, onTenantScopeViolation, onTenancyBypass,
} from '../db/index.js'
import { dropData, fakeUlid, oid, sha256ish, startDb, stopDb } from './setupDb.js'

beforeAll(async () => {
  await startDb()
})
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

const wsA = oid()
const wsB = oid()

async function seedTwoTenantProducts(): Promise<void> {
  for (const [ws, sku] of [
    [wsA, 'SKU-A'],
    [wsB, 'SKU-B'],
  ] as const) {
    await Product.create({
      workspaceId: ws,
      sku,
      name: 'Test jama',
      basePriceMinor: 50000,
      variants: [{ sku: `${sku}-V1`, name: 'Red / M', stock: 5, reserved: 0, isActive: true }],
      status: 'active',
    })
  }
}

describe('tenancy plugin — forgotten filter throws', () => {
  it('find without workspaceId throws TenantScopeViolationError', async () => {
    await seedTwoTenantProducts()
    await expect(Product.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
  })

  it('findOne without workspaceId throws', async () => {
    await expect(Product.findOne({ sku: 'SKU-A' }).exec()).rejects.toThrow(TenantScopeViolationError)
  })

  it('findOne by bare _id throws — the classic forgotten-filter shape', async () => {
    await seedTwoTenantProducts()
    const doc = await Product.findOne({ workspaceId: wsA, sku: 'SKU-A' }).exec()
    await expect(Product.findOne({ _id: doc!._id }).exec()).rejects.toThrow(TenantScopeViolationError)
  })

  it('countDocuments / distinct / updateOne / updateMany / deleteOne / deleteMany all throw', async () => {
    await expect(Product.countDocuments({}).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Product.distinct('sku', {}).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Product.updateOne({ sku: 'SKU-A' }, { $set: { name: 'x y' } }).exec()).rejects.toThrow(
      TenantScopeViolationError,
    )
    await expect(Product.updateMany({}, { $set: { category: 'x' } }).exec()).rejects.toThrow(
      TenantScopeViolationError,
    )
    await expect(Product.deleteOne({ sku: 'SKU-A' }).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Product.deleteMany({}).exec()).rejects.toThrow(TenantScopeViolationError)
  })

  it('findOneAndUpdate / findOneAndDelete / findOneAndReplace throw', async () => {
    await expect(
      Product.findOneAndUpdate({ sku: 'SKU-A' }, { $set: { name: 'x y' } }).exec(),
    ).rejects.toThrow(TenantScopeViolationError)
    await expect(Product.findOneAndDelete({ sku: 'SKU-A' }).exec()).rejects.toThrow(
      TenantScopeViolationError,
    )
    await expect(
      Product.findOneAndReplace({ sku: 'SKU-A' }, { name: 'zz' }).exec(),
    ).rejects.toThrow(TenantScopeViolationError)
  })

  it('aggregate without a leading $match on workspaceId throws', async () => {
    await expect(Order.aggregate([{ $group: { _id: '$fulfillmentStatus', n: { $sum: 1 } } }])).rejects.toThrow(
      TenantScopeViolationError,
    )
  })

  it('aggregate WITH a leading tenant $match passes', async () => {
    const rows = await Order.aggregate([
      { $match: { workspaceId: wsA } },
      { $group: { _id: '$fulfillmentStatus', n: { $sum: 1 } } },
    ])
    expect(rows).toEqual([])
  })

  it('emits the tenant.scope_violation signal on breach', async () => {
    let fired = 0
    onTenantScopeViolation(() => {
      fired += 1
    })
    await expect(Product.find({}).exec()).rejects.toThrow()
    expect(fired).toBeGreaterThan(0)
  })

  it('never silently scopes: correctly-filtered queries stay tenant-isolated', async () => {
    await seedTwoTenantProducts()
    const a = await Product.find({ workspaceId: wsA }).exec()
    expect(a).toHaveLength(1)
    expect(a[0]!.sku).toBe('SKU-A')
  })

  it('guards the other tenant-scoped collections too', async () => {
    await expect(Membership.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Conversation.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Message.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
    await expect(Customer.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
  })
})

describe('tenancy plugin — the four skipTenancy bypasses', () => {
  it.each([
    ['retentionPurger'],
    ['outboxDispatcher'],
    ['nightlyIntegrityJob'],
    ['adminReporting'],
  ])('%s can bypass ONLY with skipTenancy: true, and the bypass is logged', async (caller) => {
    await seedTwoTenantProducts()
    const logged: string[] = []
    onTenancyBypass((info) => logged.push(info.caller))

    const all = await Product.find({})
      .setOptions({ skipTenancy: true, tenancyBypassCaller: caller })
      .exec()
    expect(all).toHaveLength(2)
    expect(logged).toContain(caller)

    // Without the flag the same query still throws.
    await expect(Product.find({}).exec()).rejects.toThrow(TenantScopeViolationError)
  })

  it('aggregate honours skipTenancy for the allowlisted callers', async () => {
    await seedTwoTenantProducts()
    const rows = await Product.aggregate([{ $group: { _id: null, n: { $sum: 1 } } }]).option({
      skipTenancy: true,
      tenancyBypassCaller: 'adminReporting',
    } as never)
    expect(rows[0]).toMatchObject({ n: 2 })
  })
})

describe('tenancy plugin — exempt collections', () => {
  it('users (global identity) is not guarded', async () => {
    await User.create({
      ulid: fakeUlid(),
      email: 'Exempt@Example.com ',
      passwordHash: 'argon2id$fake',
      name: 'Exempt User',
    })
    const found = await User.findOne({ email: 'exempt@example.com' }).exec()
    expect(found).not.toBeNull()
  })

  it('sessions is not guarded', async () => {
    await expect(Session.find({}).exec()).resolves.toEqual([])
  })

  it('webhookEvents is not guarded (tenant unknown at dedupe time)', async () => {
    await WebhookEvent.create({
      provider: 'facebook',
      externalPageId: 'page-1',
      dedupeKey: 'facebook:page-1:mid_orphan',
      signatureValid: true,
      rawPayload: { object: 'page' },
      receivedAt: new Date(),
      processStatus: 'orphaned',
      expiresAt: new Date(Date.now() + 7 * 86400_000),
    })
    const found = await WebhookEvent.findOne({ dedupeKey: 'facebook:page-1:mid_orphan' }).exec()
    expect(found).not.toBeNull()
    expect(found!.workspaceId).toBeNull()
  })
})

describe('session shape sanity used by later phases', () => {
  it('stores a session with the LRU-relevant fields', async () => {
    const s = await Session.create({
      userId: oid(),
      familyId: fakeUlid(),
      refreshTokenHash: sha256ish('token-1'),
      userAgent: 'vitest',
      ipHash: sha256ish('127.0.0.1'),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 86400_000),
    })
    expect(s.generation).toBe(0)
    expect(s.revokedAt).toBeNull()
  })
})
