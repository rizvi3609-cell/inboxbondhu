'use client'

import { createContext, useContext } from 'react'

export type EventHandler = (event: string, payload: Record<string, unknown>) => void

export interface RealtimeCtx {
  subscribe: (fn: EventHandler) => () => void
  /** Bumps on every reconnect — data views refetch with updatedSince. */
  reconnects: number
  connected: boolean
}

export const RealtimeContext = createContext<RealtimeCtx>({
  subscribe: () => () => undefined,
  reconnects: 0,
  connected: false,
})

export function useRealtime(): RealtimeCtx {
  return useContext(RealtimeContext)
}
