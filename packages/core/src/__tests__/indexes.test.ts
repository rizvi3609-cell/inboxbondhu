/**
 * Index catalogue tests — Phase 1 DoD: all indexes created idempotently and
 * asserted; only the four allowlisted global uniques exist.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import {
  assertIndexes, auditGlobalIndexes, createIndexes,
  ChannelConnection, Conversation, Message, Session, StockReservation, WebhookEvent, OutboxEvent,
} from '../db/index.js'
import { startDb, stopDb } from './setupDb.js'

beforeAll(async () => {
  await startDb()
  await createIndexes()
}, 300_000)
afterAll(async () => {
  await stopDb()
})

describe('index creation and assertion', () => {
  it('createIndexes is idempotent — safe to run twice', async () => {
    await expect(createIndexes()).resolves.toBeUndefined()
  })

  it('assertIndexes finds no missing indexes after creation', async () => {
    const failures = await assertIndexes()
    expect(failures).toEqual([])
  })

  it('the five indexes that matter most exist with the exact keys', async () => {
    const conv = await Conversation.collection.indexes()
    expect(conv.find((i) => i.name === 'I24')?.key).toEqual({
      workspaceId: 1,
      status: 1,
      lastMessageAt: -1,
    })

    const msg = await Message.collection.indexes()
    expect(msg.find((i) => i.name === 'I28')?.key).toEqual({ conversationId: 1, createdAt: 1 })

    const sess = await Session.collection.indexes()
    // I05 — LRU eviction by lastUsedAt, NOT createdAt.
    expect(sess.find((i) => i.name === 'I05')?.key).toEqual({ userId: 1, lastUsedAt: -1 })

    const wh = await WebhookEvent.collection.indexes()
    const i48 = wh.find((i) => i.name === 'I48')
    expect(i48?.key).toEqual({ dedupeKey: 1 })
    expect(i48?.unique).toBe(true)

    const ch = await ChannelConnection.collection.indexes()
    const i18 = ch.find((i) => i.name === 'I18')
    expect(i18?.key).toEqual({ provider: 1, externalPageId: 1 })
    expect(i18?.unique).toBe(true)
  })

  it('text indexes exist for AI retrieval (I35 products, I37 knowledgeItems)', async () => {
    const { Product, KnowledgeItem } = await import('../db/index.js')
    const prod = await Product.collection.indexes()
    expect(prod.some((i) => i.name === 'I35')).toBe(true)
    const ki = await KnowledgeItem.collection.indexes()
    expect(ki.some((i) => i.name === 'I37')).toBe(true)
  })

  it('stockReservations has NO TTL index (DB-07)', async () => {
    const idx = await StockReservation.collection.indexes()
    expect(idx.every((i) => i.expireAfterSeconds === undefined)).toBe(true)
  })

  it('TTL indexes exist where specified (sessions I07, invitations I17, webhookEvents I50)', async () => {
    const sess = await Session.collection.indexes()
    expect(sess.find((i) => i.name === 'I07')?.expireAfterSeconds).toBe(0)
    const wh = await WebhookEvent.collection.indexes()
    expect(wh.find((i) => i.name === 'I50')?.expireAfterSeconds).toBe(0)
  })

  it('outbox dispatcher partial index I51 exists', async () => {
    const ob = await OutboxEvent.collection.indexes()
    const i51 = ob.find((i) => i.name === 'I51')
    expect(i51?.partialFilterExpression).toEqual({ status: 'pending' })
  })

  it('no global unique index exists beyond the four allowlisted (+ I15, an OPEN QUESTION tracked in indexes.ts)', () => {
    expect(auditGlobalIndexes()).toEqual([])
  })

  it('memberships uniqueness is PARTIAL on removedAt: null (I12)', async () => {
    const { Membership } = await import('../db/index.js')
    const idx = await Membership.collection.indexes()
    const i12 = idx.find((i) => i.name === 'I12')
    expect(i12?.unique).toBe(true)
    expect(i12?.partialFilterExpression).toEqual({ removedAt: null })
  })
})
