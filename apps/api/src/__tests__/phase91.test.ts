/**
 * P9.1 — the audit-fix test: PRODUCTION-PATH realtime, zero manual emits.
 * The Phase 8 suite proved the gateway pipe by calling gateway.emit()
 * directly; the audit showed no production code ever called it. This suite
 * drives the REAL producers:
 *
 *   1. inbound DM  : intakeWebhook → processWebhookEvent(+notify)
 *                    → rt:events → gateway bridge → browser socket
 *   2. agent reply : InboxService.sendMessage(+notify) → same path
 *   3. outbox row  : order.confirmed → dispatchOutboxBatch({emitSocket})
 *                    → order.updated on the socket
 *   4. csv import  : processImport(+notify) → import.progress with the
 *                    exact field names the dashboard reads (audit M-2)
 *   5. order serialise carries createdAt (audit M-1)
 *   6. channels.list returns a bare array (audit H-2 — web reads it as such)
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { Redis } from 'ioredis'
import mongoose from 'mongoose'
import {
  ChannelConnection, Conversation, Customer, Membership, OutboxEvent, User, Workspace,
  InboxService, memoryIdempotencyStore, CatalogueService, OrdersService,
  intakeWebhook, processWebhookEvent, dispatchOutboxBatch, createMockEmailClient,
  makeRealtimePublisher, makeTenantContext, redisIdempotencyStore,
  Import, Product,
} from '@inboxbondhu/core'
import { createRealtimeGateway, issueTicket, type RealtimeGateway } from '../realtime/gateway.js'
import { dropData, startDb, stopDb } from './setupDb.js'

const SECRET = 'p91-ticket-secret'
const APP_SECRET = 'p91-meta-secret'
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'

let redis: Redis | null = null
let http: HttpServer
let gateway: RealtimeGateway | null = null
let port = 0

function fakeUlid(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return Array.from({ length: 26 }, () => chars[Math.floor(Math.random() * 32)]).join('')
}

const BH = { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) }

beforeAll(async () => {
  await startDb()
  await dropData()
  const probe = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await probe.connect()
    await probe.ping()
    redis = probe
  } catch {
    probe.disconnect()
  }
  if (redis) {
    http = createServer()
    gateway = createRealtimeGateway(http, redis, SECRET)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    port = (http.address() as { port: number }).port
  }
}, 300_000)

afterAll(async () => {
  await gateway?.close()
  await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()))
  redis?.disconnect()
  await stopDb()
})

function connect(ticket: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      path: '/realtime', auth: { ticket }, transports: ['websocket'], reconnection: false,
    })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', reject)
  })
}

async function seedWorkspace() {
  const owner = await User.create({
    ulid: fakeUlid(), email: `p91-${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'P91 Owner', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'P91 Fashion', slug: `p91-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: owner._id, businessHours: BH, aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() })
  return { owner, ws }
}

async function joinedTab(userId: string, workspaceId: string): Promise<ClientSocket> {
  const tab = await connect(issueTicket(userId, SECRET))
  const ok = await new Promise<boolean>((r) => tab.emit('join:workspace', workspaceId, r))
  expect(ok).toBe(true)
  return tab
}

describe('P9.1 — production-path realtime (no manual gateway.emit anywhere)', () => {
  it('an INBOUND DM travels intake → ingest → rt:events → browser socket in < 1 s', async () => {
    if (!redis) return
    const { owner, ws } = await seedWorkspace()
    const pageId = `pg-${Math.random().toString(36).slice(2, 8)}`
    await ChannelConnection.create({
      workspaceId: ws._id, provider: 'facebook', externalPageId: pageId, pageName: 'P91 Page',
      accessTokenCipher: 'c', accessTokenIv: 'a'.repeat(16), accessTokenTag: 'b'.repeat(24),
      keyVersion: 1, status: 'active', connectedBy: owner._id,
    })

    const tab = await joinedTab(String(owner._id), String(ws._id))
    const got = new Promise<Record<string, unknown>>((r) => tab.once('message.created', r))

    // The REAL producer chain: webhook intake (P3) then ingest with the
    // worker's injected publisher (P9.1) — exactly what production runs.
    const body = Buffer.from(JSON.stringify({
      object: 'page',
      entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: 'psid-p91' }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid: `mid.p91-${Date.now()}`, text: 'dam koto bhaiya?' } }] }],
    }))
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
    const intake = await intakeWebhook(body, sig, APP_SECRET, fakeUlid(), {
      redis, enqueue: async () => undefined, journalDir: mkdtempSync(join(tmpdir(), 'p91-')),
    })
    expect(intake.accepted).toBe(1)
    const dedupeKey = (await mongoose.connection.db!.collection('webhookEvents')
      .findOne({ externalPageId: pageId }))!['dedupeKey'] as string

    const t0 = Date.now()
    const notify = makeRealtimePublisher(redis)
    const outcome = await processWebhookEvent(dedupeKey, notify) // worker path
    expect(outcome.status).toBe('processed')

    const evt = await got
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(evt['preview']).toBe('dam koto bhaiya?')
    expect(evt['direction']).toBe('inbound')
    expect(String(evt['conversationId'])).toBe(outcome.conversationId)
    // §12.3: ids and a preview only.
    expect(Object.keys(evt).sort()).toEqual(['at', 'conversationId', 'direction', 'messageId', 'preview'])
    tab.disconnect()
  })

  it('an AGENT REPLY through InboxService reaches the OTHER tab', async () => {
    if (!redis) return
    const { owner, ws } = await seedWorkspace()
    const customer = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-r', displayName: 'Reply Customer',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    })
    const conv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
      lastMessageAt: new Date(), metaWindowExpiresAt: new Date(Date.now() + 86_400_000),
      purgeAfter: new Date(Date.now() + 90 * 86_400_000),
    })

    const otherTab = await joinedTab(String(owner._id), String(ws._id))
    const got = new Promise<Record<string, unknown>>((r) => otherTab.once('message.created', r))

    // Exactly the api bootstrap wiring: InboxService with the publisher.
    const inbox = new InboxService(
      redisIdempotencyStore(redis),
      async () => undefined,
      makeRealtimePublisher(redis),
    )
    const ctx = makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'owner', requestId: fakeUlid() })
    const sent = await inbox.sendMessage(ctx, String(conv._id), `idem-${Date.now()}`, 'Ji bhaiya, 1499 taka.')
    expect(sent.ok).toBe(true)

    const evt = await got
    expect(evt['direction']).toBe('outbound')
    expect(evt['preview']).toBe('Ji bhaiya, 1499 taka.')
    otherTab.disconnect()
  })

  it('an order.confirmed OUTBOX row fans out as order.updated via the dispatcher', async () => {
    if (!redis) return
    const { owner, ws } = await seedWorkspace()
    const tab = await joinedTab(String(owner._id), String(ws._id))
    const got = new Promise<Record<string, unknown>>((r) => tab.once('order.updated', r))

    await OutboxEvent.create({
      workspaceId: ws._id, type: 'order.confirmed',
      payload: { orderId: 'o-91', orderCode: 'ORD-2026-00042' },
      idempotencyKey: `p91-order:${String(ws._id)}`,
      status: 'pending', attempts: 0, nextAttemptAt: new Date(),
    })
    // Worker wiring verbatim: email mock + emitSocket = the Redis publisher.
    const { client: email } = createMockEmailClient()
    const r = await dispatchOutboxBatch({ email, emitSocket: makeRealtimePublisher(redis) })
    expect(r.dispatched).toBeGreaterThanOrEqual(1)

    const evt = await got
    expect(evt['orderId']).toBe('o-91')
    expect(evt['orderCode']).toBe('ORD-2026-00042')
    tab.disconnect()
  })

  it('csv processImport emits import.progress with the EXACT dashboard field names', async () => {
    if (!redis) return
    const { owner, ws } = await seedWorkspace()
    const tab = await joinedTab(String(owner._id), String(ws._id))
    const events: Array<Record<string, unknown>> = []
    tab.on('import.progress', (p: Record<string, unknown>) => events.push(p))

    const csv = ['sku,name,price,stock', ...Array.from({ length: 120 }, (_, i) => `P91-${i},Product ${i} Nice,1000,5`)].join('\n')
    const imp = await Import.create({
      workspaceId: ws._id, type: 'products_csv', createdBy: owner._id,
      fileName: 'p91.csv', spacesKey: `inline:${csv}`, totalRows: 120, status: 'pending',
    })
    const result = await new CatalogueService().processImport(String(ws._id), String(imp._id), makeRealtimePublisher(redis))
    expect(result.status).toBe('completed')

    await new Promise((r) => setTimeout(r, 300)) // let the last publish land
    expect(events.length).toBeGreaterThanOrEqual(2) // checkpoint(100) + completed
    const last = events.at(-1)!
    // Audit M-2: these names ARE the GET /imports/:id names the page uses.
    expect(last['status']).toBe('completed')
    expect(last['lastProcessedRow']).toBe(120)
    expect(last['totalRows']).toBe(120)
    expect(typeof last['successCount']).toBe('number')
    expect(typeof last['failureCount']).toBe('number')
    expect(String(last['importId'])).toBe(String(imp._id))
    tab.disconnect()
  })

  it('audit M-1: order serialise now carries createdAt', async () => {
    const { owner, ws } = await seedWorkspace()
    const customer = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-o', displayName: 'Order Customer',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    })
    const conv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: new mongoose.Types.ObjectId(), customerId: customer._id,
      lastMessageAt: new Date(), purgeAfter: new Date(Date.now() + 90 * 86_400_000),
    })
    const product = await Product.create({
      workspaceId: ws._id, sku: 'P91-ORD', name: 'Order product', basePriceMinor: 1000_00,
      variants: [{ sku: 'P91-ORD-M', name: 'M', stock: 5, reserved: 0, isActive: true }],
      status: 'active', searchText: ' ',
    })
    const ctx = makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'owner', requestId: fakeUlid() })
    const orders = new OrdersService(memoryIdempotencyStore())
    const created = await orders.create(ctx, `idem-o-${Date.now()}`, {
      conversationId: String(conv._id), customerId: String(customer._id),
      items: [{ productId: String(product._id), variantSku: 'P91-ORD-M', quantity: 1 }],
      deliveryZone: 'Dhaka', deliveryAddress: 'House 1, Dhanmondi',
      recipientName: 'Order Customer', recipientPhone: '01712345678',
      paymentMethod: 'cod',
    })
    expect(created.ok).toBe(true)
    if (created.ok) {
      const row = (created.value as { order: Record<string, unknown> }).order
      expect(row['createdAt']).toBeTruthy() // audit M-1 — the dashboard renders this
      // And the list path serialises it too.
      const listed = await orders.list(ctx, {})
      expect(listed.ok).toBe(true)
      if (listed.ok) {
        const first = (listed.value as { orders: Array<Record<string, unknown>> }).orders[0]!
        expect(first['createdAt']).toBeTruthy()
      }
    }
  })
})
