/**
 * Socket.IO client per §12: fetch a 60 s ticket over HTTPS (#24), connect to
 * /realtime with it (the access token NEVER travels over the WS), join the
 * workspace room, reconnect with exponential backoff + jitter (P-08), and
 * reconcile via GET /conversations?updatedSince on every reconnect.
 */
import { io, type Socket } from 'socket.io-client'
import { api } from './api-client'

export interface RealtimeHandle {
  socket: Socket
  close: () => void
}

export async function connectRealtime(
  workspaceId: string,
  handlers: {
    onEvent: (event: string, payload: Record<string, unknown>) => void
    onReconnect: () => void
    onRevoked?: () => void
  },
): Promise<RealtimeHandle> {
  const { ticket } = await api<{ ticket: string }>('/api/v1/realtime/ticket')

  const socket = io({
    path: '/realtime',
    transports: ['websocket'],
    auth: { ticket },
    reconnection: true,
    reconnectionDelay: 1000, // exponential backoff…
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5, // …with jitter (P-08)
  })

  socket.on('connect', () => {
    socket.emit('join:workspace', workspaceId, (ok: boolean) => {
      if (!ok) handlers.onRevoked?.()
    })
  })

  // A reconnect needs a FRESH ticket (60 s TTL) — swap it before retrying.
  socket.io.on('reconnect_attempt', () => {
    void api<{ ticket: string }>('/api/v1/realtime/ticket')
      .then((t) => {
        ;(socket.auth as Record<string, unknown>)['ticket'] = t.ticket
      })
      .catch(() => undefined)
  })
  socket.io.on('reconnect', () => handlers.onReconnect())

  for (const event of ['message.created', 'conversation.updated', 'order.updated', 'import.progress', 'quota.warning']) {
    socket.on(event, (payload: Record<string, unknown>) => handlers.onEvent(event, payload))
  }
  socket.on('session.revoked', () => {
    handlers.onRevoked?.()
    socket.disconnect()
  })

  return { socket, close: () => socket.disconnect() }
}
