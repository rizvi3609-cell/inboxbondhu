/**
 * §12 realtime — Socket.IO with the Redis adapter, 60 s signed tickets
 * (the access token NEVER travels over the WebSocket), the three rooms,
 * the 5-minute membership re-check heartbeat, ID-and-preview-only payloads.
 * Best-effort delivery: the DB is authoritative; clients reconcile via
 * GET /conversations?updatedSince (§12.4).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { Server as SocketIoServer } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import { Membership, parseRealtimeEvent, REALTIME_CHANNEL } from '@inboxbondhu/core'

const TICKET_TTL_MS = 60_000
const HEARTBEAT_MS = 5 * 60_000

// ── Tickets (§12.1) ──────────────────────────────────────────────────────────

export function issueTicket(userId: string, secret: string, now = Date.now()): string {
  const expires = now + TICKET_TTL_MS
  const base = `${userId}.${expires}`
  const mac = createHmac('sha256', secret).update(base).digest('hex').slice(0, 32)
  return `${base}.${mac}`
}

export function verifyTicket(ticket: string, secret: string, now = Date.now()): { userId: string } | null {
  const parts = ticket.split('.')
  if (parts.length !== 3) return null
  const [userId, expiresStr, mac] = parts as [string, string, string]
  const expires = Number(expiresStr)
  if (!Number.isFinite(expires) || expires < now) return null // 60 s window
  const expected = createHmac('sha256', secret).update(`${userId}.${expires}`).digest('hex').slice(0, 32)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return { userId }
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export interface RealtimeGateway {
  /** Fan out — IDs and a preview only (§12.3), never full documents. */
  emit(room: string, event: string, payload: Record<string, unknown>): void
  close(): Promise<void>
}

export function createRealtimeGateway(
  httpServer: HttpServer,
  redis: Redis,
  ticketSecret: string,
): RealtimeGateway {
  // The adapter psubscribes immediately, before the duplicates finish their
  // handshake — they need the offline queue even when the boot client (which
  // must fail fast, INV-11) disables it.
  const pub = redis.duplicate({ enableOfflineQueue: true })
  const sub = redis.duplicate({ enableOfflineQueue: true })
  const io = new SocketIoServer(httpServer, {
    path: '/realtime',
    adapter: createAdapter(pub, sub), // second API instance works unchanged
    cors: { origin: false }, // same-origin; APP_URL CORS joins in P9 hardening
  })

  io.use((socket, next) => {
    const ticket = socket.handshake.auth['ticket'] as string | undefined
    const verified = ticket ? verifyTicket(ticket, ticketSecret) : null
    if (!verified) return next(new Error('invalid ticket'))
    socket.data['userId'] = verified.userId
    next()
  })

  io.on('connection', (socket) => {
    const userId = socket.data['userId'] as string
    void socket.join(`user:${userId}`)

    socket.on('join:workspace', (workspaceId: string, ack?: (ok: boolean) => void) => {
      void (async () => {
        // Active-membership check at join (§12.2).
        const member = await Membership.findOne({ workspaceId, userId, removedAt: null }).exec()
        if (!member) {
          ack?.(false)
          return
        }
        await socket.join(`ws:${workspaceId}`)
        socket.data['workspaceId'] = workspaceId
        ack?.(true)
      })()
    })

    socket.on('join:conversation', (conversationId: string) => {
      // Room join is cheap; message payloads carry only ids+previews, and the
      // REST layer re-authorises every actual read (§12.3 structural guard).
      if (socket.data['workspaceId']) void socket.join(`conv:${conversationId}`)
    })
    socket.on('leave:conversation', (conversationId: string) => {
      void socket.leave(`conv:${conversationId}`)
    })

    // THE 5-minute heartbeat: a removed member's socket dies even if they
    // never make another HTTP request (§12.2).
    const heartbeat = setInterval(() => {
      void (async () => {
        const workspaceId = socket.data['workspaceId'] as string | undefined
        if (!workspaceId) return
        const member = await Membership.findOne({ workspaceId, userId, removedAt: null }).exec()
        if (!member) {
          socket.emit('session.revoked', { reason: 'member_removed', at: new Date().toISOString() })
          socket.disconnect(true)
        }
      })()
    }, HEARTBEAT_MS)
    heartbeat.unref()
    socket.on('disconnect', () => clearInterval(heartbeat))
  })

  // P9.1 (audit H-1): the production fan-out path. Producers anywhere
  // (worker ingest/csv/dispatcher, api inbox service) publish onto ONE Redis
  // channel; every api instance receives and emits to its local room members.
  // A dedicated subscriber connection — the adapter's `sub` psubscribes to
  // the adapter's own pattern space and must not be mixed with ours.
  const bridge = redis.duplicate({ enableOfflineQueue: true })
  void bridge.subscribe(REALTIME_CHANNEL).catch(() => undefined) // Redis down ⇒ realtime degrades (P-02)
  bridge.on('message', (_channel: string, raw: string) => {
    const msg = parseRealtimeEvent(raw)
    if (msg) io.to(msg.room).emit(msg.event, msg.payload)
  })

  return {
    emit(room, event, payload) {
      io.to(room).emit(event, payload) // best-effort; DB is authoritative
    },
    async close() {
      await io.close()
      pub.disconnect()
      sub.disconnect()
      bridge.disconnect()
    },
  }
}
