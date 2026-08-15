'use client'

import { createContext, useContext } from 'react'
import type { RtEventMap } from '@inboxbondhu/contracts/views'
import type { ConnState } from './socket'

export type EventHandler = <K extends keyof RtEventMap>(event: K, payload: RtEventMap[K]) => void

export interface RealtimeCtx {
  subscribe: (fn: EventHandler) => () => void
  /** Bumps on every reconnect — data views run ONE updatedSince merge (C-8). */
  reconnects: number
  connState: ConnState
  /** Manual reconnect after the 20-attempt cap (§12.8). */
  retryNow: () => void
}

export const RealtimeContext = createContext<RealtimeCtx>({
  subscribe: () => () => undefined,
  reconnects: 0,
  connState: 'offline',
  retryNow: () => undefined,
})

export function useRealtime(): RealtimeCtx {
  return useContext(RealtimeContext)
}
