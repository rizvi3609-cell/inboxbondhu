/**
 * Realtime event bridge (P9.1 — audit fix H-1).
 *
 * Producers (ingest, inbox, csv-import, ai processor, outbox dispatcher)
 * PUBLISH {room, event, payload} JSON onto one Redis channel; the Socket.IO
 * gateway in apps/api SUBSCRIBES and fans out to rooms. Redis pub/sub keeps
 * this working across processes (worker → api) and across multiple api
 * instances (every instance receives and emits to its local sockets — the
 * adapter's room membership makes that correct, not duplicated).
 *
 * Domain modules NEVER import this file (§5.1 — notifications is reactive);
 * they receive a `RealtimePublisher` callback by injection, wired in
 * apps/api and apps/worker. Delivery stays best-effort (§12.4): the DB is
 * authoritative and clients reconcile via GET /conversations?updatedSince.
 */
import type { Redis } from 'ioredis'

export const REALTIME_CHANNEL = 'rt:events'

/** The §12.3 contract: IDs and a preview only — never full documents. */
export interface RealtimeEventMsg {
  room: string
  event: string
  payload: Record<string, unknown>
}

export type RealtimePublisher = (room: string, event: string, payload: Record<string, unknown>) => void

/**
 * Build a fire-and-forget publisher. Publish failures are swallowed by
 * design — a lost socket hint is survivable (P-02: Redis down already
 * degrades realtime); a blocked request path is not.
 */
export function makeRealtimePublisher(redis: Redis): RealtimePublisher {
  return (room, event, payload) => {
    const msg: RealtimeEventMsg = { room, event, payload }
    void redis.publish(REALTIME_CHANNEL, JSON.stringify(msg)).catch(() => undefined)
  }
}

/** Parse a channel message; null on garbage (never throw in the subscriber). */
export function parseRealtimeEvent(raw: string): RealtimeEventMsg | null {
  try {
    const msg = JSON.parse(raw) as RealtimeEventMsg
    if (typeof msg.room !== 'string' || typeof msg.event !== 'string' || typeof msg.payload !== 'object' || msg.payload === null) return null
    return msg
  } catch {
    return null
  }
}
