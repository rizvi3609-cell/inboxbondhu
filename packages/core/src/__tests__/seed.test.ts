/**
 * Phase 1 DoD: "seed script runs clean twice in a row."
 * Runs the exported runSeed() in-process against a dedicated replica set.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { runSeed } from '../db/seed.js'

let replSet: MongoMemoryReplSet

beforeAll(async () => {
  process.env['TMPDIR'] = process.env['TMPDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.cache/mongoms-data`
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
}, 300_000)

afterAll(async () => {
  await mongoose.disconnect().catch(() => undefined)
  await replSet.stop({ doCleanup: true, force: true })
})

describe('seed script', () => {
  it('runs clean twice in a row with identical final counts', async () => {
    // Tests share one process (isolate: false); detach any connection a
    // previous suite left on the default mongoose instance.
    await mongoose.disconnect().catch(() => undefined)
    const uri = replSet.getUri('inboxbondhu_seed')

    const first = await runSeed(uri)
    expect(first).toEqual({ products: 10, faqs: 20, conversations: 5, orders: 3 })

    const second = await runSeed(uri)
    expect(second).toEqual(first)

    const conn = await mongoose.createConnection(uri).asPromise()
    const db = conn.db!
    expect(await db.collection('workspaces').countDocuments()).toBe(1)
    expect(await db.collection('users').countDocuments()).toBe(1)
    expect(await db.collection('products').countDocuments()).toBe(10)
    expect(await db.collection('knowledgeItems').countDocuments()).toBe(20)
    expect(await db.collection('conversations').countDocuments()).toBe(5)
    expect(await db.collection('messages').countDocuments()).toBe(5)
    expect(await db.collection('orders').countDocuments()).toBe(3)
    expect(await db.collection('memberships').countDocuments()).toBe(1)

    // The 3 orders sit in different states.
    const states = await db
      .collection('orders')
      .distinct('fulfillmentStatus')
    expect(states.sort()).toEqual(['Collecting', 'Confirmed', 'Delivered'])

    // Order codes came from the year-scoped counter.
    const codes = (await db.collection('orders').find().toArray()).map((o) => o['orderCode']).sort()
    expect(codes).toEqual(['ORD-2026-00001', 'ORD-2026-00002', 'ORD-2026-00003'])
    await conn.close()
  })
})
