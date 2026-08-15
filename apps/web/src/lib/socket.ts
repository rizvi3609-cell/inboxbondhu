/**
 * Socket.IO client per §12 + FRONTEND-SPEC C-8 — the §12.8 policy VERBATIM:
 *   delay = min(30s, 500ms * 2^n) * random()        (full jitter)
 *   hard cap: 20 attempts → surface a manual "Reconnect" button
 *   on reconnect: send lastEventAt upstream via GET ?updatedSince → DELTA,
 *   never a full refetch (thundering-herd protection, P-08).
 *
 * socket.io-client is imported dynamically so the app shell never waits for
 * it (spec §5.2 item 3).
 */
import type { Socket } from 'socket.io-client'
import type { RtEventMap } from '@inboxbondhu/contracts/views'
import { api } from './api-client'

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'gave_up' | 'offline'

export interface RealtimeHandle {
  close: () => void
  /** Manual reconnect after the 20-attempt cap (C-8). */
  retryNow: () => void
}

export interface RealtimeCallbacks {
  onEvent: <K extends keyof RtEventMap>(event: K, payload: RtEventMap[K]) => void
  /** Fired on every successful (re)connect AFTER the first — trigger updatedSince merges. */
  onReconnect: () => void
  onState: (state: ConnState) => void
  onRevoked?: () => void
}

const MAX_ATTEMPTS = 20 // §12.8 hard limit
const EVENTS: ReadonlyArray<keyof RtEventMap> = [
  'message.created', 'conversation.updated', 'order.updated',
  'import.progress', 'quota.warning',
]

/** §12.8 formula, verbatim: min(30s, 500ms * 2^n) * random(). */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  return Math.min(30_000, 500 * 2 ** attempt) * rand()
}

export async function connectRealtime(
  workspaceId: string,
  cb: RealtimeCallbacks,
): Promise<RealtimeHandle> {
  const { io } = await import('socket.io-client') // lazy — §5.2
  let socket: Socket | null = null
  let attempts = 0
  let closed = false
  let everConnected = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  async function freshTicket(): Promise<string | null> {
    try {
      const { ticket } = await api<{ ticket: string }>('/api/v1/realtime/ticket')
      return ticket
    } catch {
      return null
    }
  }

  function scheduleRetry() {
    if (closed) return
    if (attempts >= MAX_ATTEMPTS) {
      cb.onState('gave_up') // → the UI shows the manual Reconnect button
      return
    }
    const delay = backoffDelay(attempts)
    attempts += 1
    cb.onState('reconnecting')
    retryTimer = setTimeout(() => void connect(), delay)
  }

  async function connect(): Promise<void> {
    if (closed) return
    const ticket = await freshTicket() // tickets live 60 s — always fresh per attempt
    if (closed) return
    if (!ticket) {
      scheduleRetry()
      return
    }

    socket?.removeAllListeners()
    socket?.disconnect()
    socket = io({
      path: '/realtime',
      transports: ['websocket'],
      auth: { ticket },
      reconnection: false, // OUR policy runs the schedule, not socket.io's
    })

    socket.on('connect', () => {
      attempts = 0
      socket!.emit('join:workspace', workspaceId, (ok: boolean) => {
        if (!ok) {
          cb.onRevoked?.()
          return
        }
        cb.onState('connected')
        if (everConnected) cb.onReconnect() // delta sync, not full refetch (C-8)
        everConnected = true
      })
    })

    socket.on('connect_error', () => scheduleRetry())
    socket.on('disconnect', (reason) => {
      if (closed) return
      if (reason === 'io server disconnect') return // revocation path emits session.revoked first
      scheduleRetry()
    })

    for (const event of EVENTS) {
      socket.on(event as string, (payload: RtEventMap[typeof event]) => cb.onEvent(event, payload))
    }
    socket.on('session.revoked', (p: RtEventMap['session.revoked']) => {
      cb.onEvent('session.revoked', p)
      cb.onRevoked?.()
      closed = true
      socket?.disconnect()
    })
  }

  cb.onState('connecting')
  void connect()

  return {
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      socket?.removeAllListeners()
      socket?.disconnect()
    },
    retryNow() {
      if (closed) return
      attempts = 0 // the human pressed the button — reset the budget
      if (retryTimer) clearTimeout(retryTimer)
      void connect()
    },
  }
}
