/**
 * Phase 4 HTTP tests — routes #40–45 over supertest:
 * - DoD: inbox list p95 < 200 ms on seeded volume (500 conversations)
 * - Idempotency-Key: missing → 428; same key twice → one message, 200 replay
 * - If-Match discipline on PATCH; RBAC (viewer read-only)
 * - cross-tenant 403 on the new routes (the gate never regresses)
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import request, { type Response as SupertestResponse } from 'supertest'
import mongoose from 'mongoose'
import type { Express } from 'express'
import {
  Conversation, Customer, Membership, Message, User,
  InboxService, memoryIdempotencyStore,
} from '@inboxbondhu/core'
import { createApp } from '../app.js'
import { dropData, startDb, stopDb } from './setupDb.js'

const STRONG = 'Krishnochura#Dhanmondi27'
const DAY_MS = 86_400_000

let app: Express
let enqueued: string[]

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})

beforeEach(async () => {
  await dropData()
  enqueued = []
  const inbox = new InboxService(memoryIdempotencyStore(), async (job) => {
    enqueued.push(job.payload.messageId)
  })
  app = createApp({
    clients: null,
    version: 'test',
    startedAt: Date.now(),
    auth: {
      jwtSecret: 'x'.repeat(32),
      pepper: 'test-pepper-test-pepper',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      maxSessions: 5,
      secureCookies: false,
    },
    inbox: { service: inbox },
  })
})

function setCookies(res: SupertestResponse): string[] {
  const raw = res.get('set-cookie') as string[] | string | undefined
  return raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
}
function cookieOf(res: SupertestResponse, name: string): string {
  const hit = setCookies(res).find((c) => c.startsWith(`${name}=`))
  if (!hit) throw new Error(`cookie ${name} not set`)
  return hit.split(';')[0]!
}

interface Actor { userId: string; workspaceId: string; at: string; csrf: string }

async function login(email: string, storeName: string): Promise<Actor> {
  const reg = await request(app).post('/api/v1/auth/register').send({
    email, password: STRONG, name: 'Test Seller', storeName,
  })
  const { userId, workspaceId } = reg.body.data as { userId: string; workspaceId: string }
  await User.updateOne({ _id: userId }, { $set: { emailVerifiedAt: new Date() } }).exec()
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: STRONG })
  return { userId, workspaceId, at: cookieOf(res, 'ib_at'), csrf: cookieOf(res, 'ib_csrf').split('=')[1]! }
}

async function seedConversations(workspaceId: string, count: number): Promise<string[]> {
  const customer = await Customer.create({
    workspaceId, provider: 'facebook', externalUserId: 'psid-t', displayName: 'Seed Customer',
    firstSeenAt: new Date(), lastSeenAt: new Date(),
  })
  const ids: string[] = []
  const docs = Array.from({ length: count }, (_, i) => ({
    workspaceId,
    channelConnectionId: new mongoose.Types.ObjectId(),
    customerId: customer._id,
    status: 'open',
    mode: 'ai',
    lastMessageAt: new Date(Date.now() - i * 1000),
    lastMessagePreview: `message ${i}`,
    lastMessageDirection: 'inbound',
    unreadCount: 1,
    messageCount: 1,
    metaWindowExpiresAt: new Date(Date.now() + DAY_MS),
    countedForBilling: false,
    tags: [],
    version: 0,
    purgeAfter: new Date(Date.now() + 90 * DAY_MS),
  }))
  const inserted = await Conversation.insertMany(docs)
  for (const d of inserted) ids.push(String(d._id))
  return ids
}

describe('DoD — inbox list p95 < 200 ms on seeded volume', () => {
  it('500 conversations, 20 sequential requests: p95 under 200 ms', async () => {
    const a = await login('perf@x.example', 'Perf Store')
    await seedConversations(a.workspaceId, 500)

    const durations: number[] = []
    for (let i = 0; i < 20; i += 1) {
      const t0 = performance.now()
      const res = await request(app).get(`/api/v1/w/${a.workspaceId}/conversations`).set('Cookie', a.at)
      durations.push(performance.now() - t0)
      expect(res.status).toBe(200)
      expect(res.body.data.conversations).toHaveLength(20) // default 20
    }
    durations.sort((x, y) => x - y)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1]!
    expect(p95).toBeLessThan(200)
  })
})

describe('#44 send message — Idempotency-Key over HTTP', () => {
  it('missing key → 428; same key twice → 201 then 200 replay with the SAME id', async () => {
    const a = await login('idem@x.example', 'Idem Store')
    const [convId] = await seedConversations(a.workspaceId, 1)
    const cookies = `${a.at}; ib_csrf=${a.csrf}`

    const missing = await request(app)
      .post(`/api/v1/w/${a.workspaceId}/conversations/${convId}/messages`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf)
      .send({ text: 'Ji ache!' })
    expect(missing.status).toBe(428)
    expect(missing.body.error.code).toBe('PRECONDITION_REQUIRED')

    const first = await request(app)
      .post(`/api/v1/w/${a.workspaceId}/conversations/${convId}/messages`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf)
      .set('Idempotency-Key', 'client-key-0001')
      .send({ text: 'Ji ache!' })
    expect(first.status).toBe(201)
    const messageId = first.body.data.messageId as string

    const replay = await request(app)
      .post(`/api/v1/w/${a.workspaceId}/conversations/${convId}/messages`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf)
      .set('Idempotency-Key', 'client-key-0001')
      .send({ text: 'Ji ache!' })
    expect(replay.status).toBe(200) // never 201, never an error
    expect(replay.body.data.messageId).toBe(messageId)
    expect(replay.body.data.replayed).toBe(true)

    expect(await Message.countDocuments({ direction: 'outbound' }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }).exec()).toBe(1)
    expect(enqueued).toHaveLength(1)

    // The reply took the conversation to human mode.
    const conv = await Conversation.findOne({ _id: convId, workspaceId: a.workspaceId }).exec()
    expect(conv!.mode).toBe('human')
  })
})

describe('#42 PATCH — If-Match + take-over over HTTP', () => {
  it('missing If-Match → 428; take-over works; stale → 409', async () => {
    const a = await login('patch@x.example', 'Patch Store')
    const [convId] = await seedConversations(a.workspaceId, 1)
    const cookies = `${a.at}; ib_csrf=${a.csrf}`

    const missing = await request(app)
      .patch(`/api/v1/w/${a.workspaceId}/conversations/${convId}`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf)
      .send({ mode: 'human' })
    expect(missing.status).toBe(428)

    const takeOver = await request(app)
      .patch(`/api/v1/w/${a.workspaceId}/conversations/${convId}`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf).set('If-Match', '0')
      .send({ mode: 'human' })
    expect(takeOver.status).toBe(200)

    const stale = await request(app)
      .patch(`/api/v1/w/${a.workspaceId}/conversations/${convId}`)
      .set('Cookie', cookies).set('X-CSRF-Token', a.csrf).set('If-Match', '0')
      .send({ status: 'resolved' })
    expect(stale.status).toBe(409)
    expect(stale.body.error.currentVersion).toBe(1)
  })
})

describe('RBAC + tenancy on the new routes', () => {
  it('viewer can list/read but not PATCH or send; foreign workspace → 403', async () => {
    const alice = await login('alice-p4@x.example', 'Alice P4')
    const mallory = await login('mallory-p4@x.example', 'Mallory P4')
    const [convId] = await seedConversations(alice.workspaceId, 1)

    // Make a viewer in alice's workspace.
    const viewer = await login('viewer-p4@x.example', 'Viewer P4')
    await Membership.create({
      workspaceId: alice.workspaceId, userId: viewer.userId, role: 'viewer', joinedAt: new Date(),
    })
    const viewerCookies = `${viewer.at}; ib_csrf=${viewer.csrf}`

    const list = await request(app).get(`/api/v1/w/${alice.workspaceId}/conversations`).set('Cookie', viewer.at)
    expect(list.status).toBe(200)

    const patch = await request(app)
      .patch(`/api/v1/w/${alice.workspaceId}/conversations/${convId}`)
      .set('Cookie', viewerCookies).set('X-CSRF-Token', viewer.csrf).set('If-Match', '0')
      .send({ mode: 'human' })
    expect(patch.status).toBe(403)
    expect(patch.body.error.code).toBe('INSUFFICIENT_PERMISSIONS')

    const send = await request(app)
      .post(`/api/v1/w/${alice.workspaceId}/conversations/${convId}/messages`)
      .set('Cookie', viewerCookies).set('X-CSRF-Token', viewer.csrf)
      .set('Idempotency-Key', 'viewer-key-001')
      .send({ text: 'should fail' })
    expect(send.status).toBe(403)

    // Cross-tenant: mallory (not a member) → 403 WORKSPACE_FORBIDDEN.
    const foreign = await request(app).get(`/api/v1/w/${alice.workspaceId}/conversations`).set('Cookie', mallory.at)
    expect(foreign.status).toBe(403)
    expect(foreign.body.error.code).toBe('WORKSPACE_FORBIDDEN')

    // A foreign conversation id inside mallory's OWN workspace → 404, no leak.
    const notFound = await request(app)
      .get(`/api/v1/w/${mallory.workspaceId}/conversations/${convId}`)
      .set('Cookie', mallory.at)
    expect(notFound.status).toBe(404)
    expect(notFound.body.error.code).toBe('NOT_FOUND')
  })
})

describe('#45 retry over HTTP', () => {
  it('requeues a failed message', async () => {
    const a = await login('retry-p4@x.example', 'Retry P4')
    const [convId] = await seedConversations(a.workspaceId, 1)
    const failed = await Message.create({
      workspaceId: a.workspaceId, conversationId: convId, direction: 'outbound',
      author: { type: 'agent', userId: a.userId }, contentType: 'text', text: 'retry me',
      status: 'failed', failureCode: 'FB_5XX',
    })
    const res = await request(app)
      .post(`/api/v1/w/${a.workspaceId}/messages/${String(failed._id)}/retry`)
      .set('Cookie', `${a.at}; ib_csrf=${a.csrf}`).set('X-CSRF-Token', a.csrf)
    expect(res.status).toBe(200)
    expect(enqueued).toContain(String(failed._id))
  })
})
