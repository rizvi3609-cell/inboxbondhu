/**
 * OCC plugin tests — version increments on save; the conditional-filter path
 * raises VERSION_CONFLICT carrying currentVersion + conflictingFields.
 * `messages` deliberately has NO version field (append-mostly) — asserted here.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { VersionConflictError } from '../kernel/appError.js'
import { Conversation, Message, Order, occFilter, throwVersionConflict } from '../db/index.js'
import { dropData, oid, startDb, stopDb } from './setupDb.js'

beforeAll(async () => {
  await startDb()
})
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

const ws = oid()

function makeConversation() {
  return Conversation.create({
    workspaceId: ws,
    channelConnectionId: oid(),
    customerId: oid(),
    lastMessageAt: new Date(),
    purgeAfter: new Date(Date.now() + 90 * 86400_000),
  })
}

describe('occ plugin', () => {
  it('new documents start at version 0', async () => {
    const conv = await makeConversation()
    expect(conv.version).toBe(0)
  })

  it('save() on a modified doc increments version', async () => {
    const conv = await makeConversation()
    conv.status = 'pending'
    await conv.save()
    expect(conv.version).toBe(1)
    conv.status = 'resolved'
    await conv.save()
    expect(conv.version).toBe(2)
  })

  it('updateOne bumps version via $inc automatically', async () => {
    const conv = await makeConversation()
    await Conversation.updateOne(
      { _id: conv._id, workspaceId: ws },
      { $set: { status: 'pending' } },
    ).exec()
    const fresh = await Conversation.findOne({ _id: conv._id, workspaceId: ws }).exec()
    expect(fresh!.version).toBe(1)
  })

  it('stale conditional update matches nothing; the helper raises 409 VERSION_CONFLICT', async () => {
    const conv = await makeConversation()
    // Someone else moves it forward.
    await Conversation.updateOne(
      { _id: conv._id, workspaceId: ws },
      { $set: { status: 'pending' } },
    ).exec()

    // Our write still believes version 0.
    const res = await Conversation.updateOne(
      { _id: conv._id, workspaceId: ws, ...occFilter(0) },
      { $set: { status: 'resolved' } },
    ).exec()
    expect(res.matchedCount).toBe(0)

    const fresh = await Conversation.findOne({ _id: conv._id, workspaceId: ws }).exec()
    let caught: VersionConflictError | null = null
    try {
      throwVersionConflict(fresh!.version, ['status'])
    } catch (e) {
      caught = e as VersionConflictError
    }
    expect(caught).toBeInstanceOf(VersionConflictError)
    expect(caught!.code).toBe('VERSION_CONFLICT')
    expect(caught!.currentVersion).toBe(1)
    expect(caught!.conflictingFields).toEqual(['status'])
  })

  it('first-wins under two concurrent conditional writes; the loser gets zero matches', async () => {
    const conv = await makeConversation()
    const [a, b] = await Promise.all([
      Conversation.updateOne(
        { _id: conv._id, workspaceId: ws, ...occFilter(0) },
        { $set: { status: 'pending' } },
      ).exec(),
      Conversation.updateOne(
        { _id: conv._id, workspaceId: ws, ...occFilter(0) },
        { $set: { status: 'resolved' } },
      ).exec(),
    ])
    const matched = a.matchedCount + b.matchedCount
    expect(matched).toBe(1) // exactly one winner
    const fresh = await Conversation.findOne({ _id: conv._id, workspaceId: ws }).exec()
    expect(fresh!.version).toBe(1)
  })

  it('orders carry OCC; messages deliberately do NOT (gotcha #9)', async () => {
    expect(Order.schema.path('version')).toBeDefined()
    expect(Message.schema.path('version')).toBeUndefined()
  })
})
