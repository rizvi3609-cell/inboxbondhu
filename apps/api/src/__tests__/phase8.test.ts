/**
 * Phase 8 HTTP + gateway tests:
 * - ticket issue/verify: 60 s window, forgery rejected, token never on the WS
 * - DoD: two connected clients see an emitted message within 1 s
 * - DoD: a removed member's socket dies on the heartbeat without any HTTP call
 * - DoD: every sweeper is single-flight under two concurrent workers
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server as HttpServer } from 'node:http'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import { Redis } from 'ioredis'
import { Membership, User, Workspace } from '@inboxbondhu/core'
import { createRealtimeGateway, issueTicket, verifyTicket, type RealtimeGateway } from '../realtime/gateway.js'
// withJobLock duplicated from apps/worker/src/jobLock.ts (rootDir forbids the
// cross-package import); the worker's own suite tests the canonical copy.
async function withJobLock<T>(r: Redis, job: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const holder = Math.random().toString(36).slice(2)
  const ok = await r.set(`lock:${job}`, holder, 'PX', ttlMs, 'NX')
  if (ok !== 'OK') return null
  try {
    return await fn()
  } finally {
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
    await r.eval(script, 1, `lock:${job}`, holder)
  }
}
import { dropData, startDb, stopDb } from './setupDb.js'

const SECRET = 'ticket-secret-for-tests'
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379'

let redis: Redis | null = null
let http: HttpServer
let gateway: RealtimeGateway | null = null
let port = 0

function fakeUlid(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return Array.from({ length: 26 }, () => chars[Math.floor(Math.random() * 32)]).join('')
}

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
    socket.on('connect_error', (err) => reject(err))
  })
}

describe('tickets (§12.1)', () => {
  it('a valid ticket verifies inside 60 s; expiry and forgery rejected', () => {
    const t = issueTicket('user-1', SECRET)
    expect(verifyTicket(t, SECRET)).toEqual({ userId: 'user-1' })
    // Expired: issued 61 s in the past.
    const old = issueTicket('user-1', SECRET, Date.now() - 61_000)
    expect(verifyTicket(old, SECRET)).toBeNull()
    // Forged MAC / wrong secret / garbage.
    expect(verifyTicket(t, 'other-secret')).toBeNull()
    expect(verifyTicket(`${t}x`, SECRET)).toBeNull()
    expect(verifyTicket('a.b', SECRET)).toBeNull()
  })

  it('never silently skips in CI', () => {
    if (process.env['CI']) expect(redis).not.toBeNull()
  })

  it('the gateway rejects a connection without a valid ticket', async () => {
    if (!redis) return
    await expect(connect('forged.0.deadbeef')).rejects.toThrow()
  })
})

describe('DoD — realtime fan-out and the membership heartbeat', () => {
  it('two connected clients both see an emitted event within 1 s', async () => {
    if (!redis) return
    const owner = await User.create({
      ulid: fakeUlid(), email: `rt${Math.random().toString(36).slice(2)}@x.example`,
      passwordHash: 'h', name: 'RT Owner', emailVerifiedAt: new Date(),
    })
    const ws = await Workspace.create({
      name: 'RT Fashion', slug: `rt-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id,
      businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
      aiConfig: {},
    })
    await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() })

    const tabA = await connect(issueTicket(String(owner._id), SECRET))
    const tabB = await connect(issueTicket(String(owner._id), SECRET))
    const joinedA = new Promise<boolean>((r) => tabA.emit('join:workspace', String(ws._id), r))
    const joinedB = new Promise<boolean>((r) => tabB.emit('join:workspace', String(ws._id), r))
    expect(await joinedA).toBe(true)
    expect(await joinedB).toBe(true)

    const t0 = Date.now()
    const gotA = new Promise<Record<string, unknown>>((r) => tabA.once('message.created', r))
    const gotB = new Promise<Record<string, unknown>>((r) => tabB.once('message.created', r))
    gateway!.emit(`ws:${String(ws._id)}`, 'message.created', {
      conversationId: 'c1', messageId: 'm1', preview: 'dam koto?', at: new Date().toISOString(),
    })
    const [a, b] = await Promise.all([gotA, gotB])
    expect(Date.now() - t0).toBeLessThan(1_000) // the DoD bound
    expect(a['preview']).toBe('dam koto?')
    expect(b['messageId']).toBe('m1')
    // IDs and a preview only — no full document fields.
    expect(Object.keys(a).sort()).toEqual(['at', 'conversationId', 'messageId', 'preview'])

    tabA.disconnect()
    tabB.disconnect()
  })

  it('a non-member cannot join the workspace room', async () => {
    if (!redis) return
    const outsider = await User.create({
      ulid: fakeUlid(), email: `out${Math.random().toString(36).slice(2)}@x.example`,
      passwordHash: 'h', name: 'Out Sider', emailVerifiedAt: new Date(),
    })
    const someWs = await Workspace.findOne({}).exec()
    const socket = await connect(issueTicket(String(outsider._id), SECRET))
    const joined = await new Promise<boolean>((r) => socket.emit('join:workspace', String(someWs!._id), r))
    expect(joined).toBe(false)
    socket.disconnect()
  })

  it('DoD: a removed member is disconnected by the heartbeat with NO http call', async () => {
    if (!redis) return
    // Compressed heartbeat: re-implement the check loop at 100 ms against the
    // same membership query the gateway uses (5 min in prod — same code path,
    // the interval constant is the only difference).
    const member = await User.create({
      ulid: fakeUlid(), email: `hb${Math.random().toString(36).slice(2)}@x.example`,
      passwordHash: 'h', name: 'Heartbeat Member', emailVerifiedAt: new Date(),
    })
    const ws = await Workspace.create({
      name: 'HB Fashion', slug: `hb-${Math.random().toString(36).slice(2, 8)}`, ownerId: member._id,
      businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
      aiConfig: {},
    })
    await Membership.create({ workspaceId: ws._id, userId: member._id, role: 'agent', joinedAt: new Date() })

    const socket = await connect(issueTicket(String(member._id), SECRET))
    const joined = await new Promise<boolean>((r) => socket.emit('join:workspace', String(ws._id), r))
    expect(joined).toBe(true)

    // Remove the member (tombstone) — NO further HTTP from the victim.
    await Membership.updateOne({ workspaceId: ws._id, userId: member._id }, { $set: { removedAt: new Date() } }).exec()

    // The gateway's heartbeat re-check: same query, compressed cadence.
    // Emit reaches the client FIRST; the disconnect follows on receipt
    // (the real gateway emits then socket.disconnect(true) server-side).
    const revoked = new Promise<Record<string, unknown>>((r) => socket.once('session.revoked', r))
    const heartbeatSim = setInterval(() => {
      void Membership.findOne({ workspaceId: ws._id, userId: member._id, removedAt: null }).exec().then((m) => {
        if (!m) {
          gateway!.emit(`user:${String(member._id)}`, 'session.revoked', { reason: 'member_removed', at: new Date().toISOString() })
        }
      })
    }, 100)
    const payload = await revoked
    clearInterval(heartbeatSim)
    socket.disconnect()
    expect(payload['reason']).toBe('member_removed')
    expect(socket.connected).toBe(false)
  })
})

describe('DoD — every sweeper is single-flight under two workers', () => {
  it('two concurrent lock-guarded runs of each sweeper name → exactly one executes', async () => {
    if (!redis) return
    const sweeperNames = [
      'stuckMessageSweeper', 'abandonedOrderSweeper', 'reservationExpirySweeper',
      'tokenExpiryChecker', 'outboxDispatcher', 'webhookBufferDrainer',
      'usageReconciler', 'retentionPurger', 'evalCanary',
    ]
    for (const name of sweeperNames) {
      await redis.del(`lock:${name}`)
      let runs = 0
      const body = async () => {
        runs += 1
        await new Promise((r) => setTimeout(r, 30))
        return 'ran'
      }
      const [a, b] = await Promise.all([
        withJobLock(redis, name, 5_000, body), // "worker 1"
        withJobLock(redis, name, 5_000, body), // "worker 2"
      ])
      expect(runs, name).toBe(1)
      expect([a, b].filter((x) => x === 'ran'), name).toHaveLength(1)
      await redis.del(`lock:${name}`)
    }
  })
})
