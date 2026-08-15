'use client'

/**
 * Workspace app shell (F1): MotionRoot + ToastProvider + realtime provider
 * (§12.8 policy lives in lib/socket), animated sidebar, the four global
 * banners. Children render inside a <main> that template.tsx animates.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { MotionRoot } from '@/lib/motion'
import { connectRealtime, type ConnState, type RealtimeHandle } from '@/lib/socket'
import { RealtimeContext, type EventHandler } from '@/lib/realtime-context'
import { ToastProvider } from '@/components/ui/overlay'
import { Sidebar } from '@/components/shell/Sidebar'
import {
  ChannelExpiryBanner, DegradedBanner, QuotaBanner, SocketGaveUpBanner,
} from '@/components/shell/Banners'

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const router = useRouter()
  const handlers = useRef(new Set<EventHandler>())
  const handleRef = useRef<RealtimeHandle | null>(null)
  const [reconnects, setReconnects] = useState(0)
  const [connState, setConnState] = useState<ConnState>('connecting')

  useEffect(() => {
    let cancelled = false
    void connectRealtime(workspaceId, {
      onEvent: (event, payload) => {
        for (const fn of handlers.current) fn(event, payload)
      },
      onReconnect: () => setReconnects((n) => n + 1),
      onState: (s) => {
        if (!cancelled) setConnState(s)
      },
      onRevoked: () => router.push('/workspaces'),
    }).then((h) => {
      if (cancelled) {
        h.close()
        return
      }
      handleRef.current = h
    })
    return () => {
      cancelled = true
      handleRef.current?.close()
      handleRef.current = null
    }
  }, [workspaceId, router])

  // §7.2: tab hidden >5 min → silent updatedSince sync on focus
  // (bumping `reconnects` is exactly that signal to every list).
  useEffect(() => {
    let hiddenAt = 0
    function onVisibility() {
      if (document.hidden) {
        hiddenAt = Date.now()
      } else if (hiddenAt > 0 && Date.now() - hiddenAt > 5 * 60_000) {
        setReconnects((n) => n + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  return (
    <MotionRoot>
      <ToastProvider>
        <RealtimeContext.Provider
          value={{
            subscribe: (fn) => {
              handlers.current.add(fn)
              return () => handlers.current.delete(fn)
            },
            reconnects,
            connState,
            retryNow: () => handleRef.current?.retryNow(),
          }}
        >
          <div style={{ display: 'flex', minHeight: '100vh' }}>
            <Sidebar workspaceId={workspaceId} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <DegradedBanner />
              <SocketGaveUpBanner />
              <QuotaBanner workspaceId={workspaceId} />
              <ChannelExpiryBanner workspaceId={workspaceId} expiringPageName={null} />
              <main style={{ flex: 1, padding: 20, minWidth: 0 }}>{children}</main>
            </div>
          </div>
        </RealtimeContext.Provider>
      </ToastProvider>
    </MotionRoot>
  )
}
