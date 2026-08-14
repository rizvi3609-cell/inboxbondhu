/**
 * $jsonSchema generation tests — validators are GENERATED from Zod, applied
 * via collMod, and visible in db.getCollectionInfos() (Phase 1 DoD).
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { applyValidators, createIndexes } from '../db/index.js'
import { generateAll } from '../db/jsonSchema/generate.js'
import { startDb, stopDb } from './setupDb.js'

beforeAll(async () => {
  await startDb()
  await createIndexes()
}, 300_000)
afterAll(async () => {
  await stopDb()
})

describe('generated $jsonSchema validators', () => {
  it('generates one validator per collection (19)', () => {
    const all = generateAll()
    expect(Object.keys(all)).toHaveLength(19)
    expect(all['orders']).toBeDefined()
    expect(all['webhookEvents']).toBeDefined()
  })

  it('orders validator carries the money-loss controls', () => {
    const orders = generateAll()['orders'] as {
      properties: Record<string, Record<string, unknown>>
    }
    // discountPercent 0..50 — layer 2 of the 3-layer control.
    const dp = orders.properties['discountPercent'] as { anyOf?: { maximum?: number }[] } & {
      maximum?: number
    }
    const max = dp.maximum ?? dp.anyOf?.find((x) => x.maximum !== undefined)?.maximum
    expect(max).toBe(50)
    // Money fields are integer bson types.
    const total = orders.properties['totalMinor'] as { bsonType: string[] }
    expect(total.bsonType).toEqual(['int', 'long'])
  })

  it('applyValidators makes validators visible in getCollectionInfos', async () => {
    const applied = await applyValidators()
    expect(applied).toHaveLength(19)
    const db = mongoose.connection.db!
    const infos = await db.listCollections({ name: 'orders' }).toArray()
    const validator = (infos[0] as { options?: { validator?: unknown } }).options?.validator
    expect(validator).toBeDefined()
    expect((validator as { $jsonSchema?: unknown }).$jsonSchema).toBeDefined()
  })

  it('DB validator rejects an out-of-range discountPercent even via a raw driver write', async () => {
    await applyValidators()
    const db = mongoose.connection.db!
    await expect(
      db.collection('orders').insertOne({
        workspaceId: new mongoose.Types.ObjectId(),
        orderNumber: 1,
        orderYear: 2026,
        orderCode: 'ORD-2026-00001',
        conversationId: new mongoose.Types.ObjectId(),
        customerId: new mongoose.Types.ObjectId(),
        items: [],
        subtotalMinor: 100,
        discountMinor: 0,
        discountPercent: 90, // > 50 — must be rejected by the DB itself
        deliveryFeeMinor: 0,
        totalMinor: 100,
        deliveryZone: 'Dhaka',
        deliveryAddress: 'a',
        recipientName: 'r',
        recipientPhone: '01712345678',
        fulfillmentStatus: 'Collecting',
        paymentStatus: 'Unpaid',
        paymentMethod: 'cod',
        statusHistory: [],
        createdByType: 'ai',
        version: 0,
        purgeAfter: new Date(),
      }),
    ).rejects.toThrow(/Document failed validation/)
  })
})
