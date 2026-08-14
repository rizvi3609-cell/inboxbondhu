'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { api } from '@/lib/api-client'
import { connectRealtime, type RealtimeHandle } from '@/lib/socket'
import { RealtimeContext, type EventHandler } from '@/lib/realtime-context'

const NAV = [
  ['inbox', 'Inbox'],
  ['orders', 'Orders'],
  ['catalogue', 'Catalogue'],
  ['knowledge', 'Knowledge'],
  ['analytics', 'Analytics'],
  ['settings', 'Settings'],
] as const

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const pathname = usePathname()
  const router = useRouter()
  const handlers = useRef(new Set<EventHandler>())
  const [reconnects, setReconnects] = useState(0)
  const [connected, setConnected] = useState(false)
  const [degraded, setDegraded] = useState(false)

  useEffect(() => {
    let handle: RealtimeHandle | null = null
    let cancelled = false
    void connectRealtime(workspaceId, {
      onEvent: (event, payload) => {
        for (const fn of handlers.current) fn(event, payload)
      },
      onReconnect: () => setReconnects((n) => n + 1),
      onRevoked: () => router.push('/workspaces'),
    })
      .then((h) => {
        if (cancelled) {
          h.close()
          return
        }
        handle = h
        setConnected(true)
        h.socket.on('disconnect', () => setConnected(false))
        h.socket.on('connect', () => setConnected(true))
      })
      .catch(() => setConnected(false))
    return () => {
      cancelled = true
      handle?.close()
    }
  }, [workspaceId, router])

  // Degraded-mode banner: /healthz is cheap and dependency-free (proxied).
  useEffect(() => {
    const poll = setInterval(() => {
      void fetch('/healthz')
        .then((r) => r.json())
        .then((j: { data?: { degraded?: boolean } }) => setDegraded(Boolean(j.data?.degraded)))
        .catch(() => setDegraded(true))
    }, 30_000)
    return () => clearInterval(poll)
  }, [])

  async function logout() {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined)
    router.push('/login')
  }

  return (
    <RealtimeContext.Provider
      value={{
        subscribe: (fn) => {
          handlers.current.add(fn)
          return () => handlers.current.delete(fn)
        },
        reconnects,
        connected,
      }}
    >
      <div style={{ display: 'flex', minHeight: '100vh' }}>
        <aside style={{ width: 200, borderRight: '1px solid var(--border)', background: 'var(--panel)', padding: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>
            InboxBondhu{' '}
            <span title={connected ? 'realtime connected' : 'realtime offline — reads still work'} style={{ fontSize: 10, color: connected ? 'var(--ok)' : 'var(--muted)' }}>●</span>
          </div>
          {NAV.map(([seg, label]) => {
            const href = `/w/${workspaceId}/${seg}`
            const active = pathname.startsWith(href)
            return (
              <Link key={seg} href={href} style={{
                padding: '7px 10px', borderRadius: 6, color: active ? 'var(--brand)' : 'var(--text)',
                background: active ? 'var(--brand-soft)' : 'transparent', fontWeight: active ? 600 : 400,
              }}>
                {label}
              </Link>
            )
          })}
          <div style={{ marginTop: 'auto' }}>
            <Link href="/workspaces" className="muted" style={{ display: 'block', padding: '6px 10px' }}>Switch workspace</Link>
            <button onClick={() => void logout()} style={{ width: '100%', marginTop: 4 }}>Sign out</button>
          </div>
        </aside>
        <main style={{ flex: 1, padding: 20, minWidth: 0 }}>
          {degraded && (
            <div className="card" style={{ background: '#fef2f2', borderColor: '#fecaca', marginBottom: 12 }}>
              ⚠ Degraded mode — the database is unreachable. Incoming customer messages are still being received and buffered; the dashboard is read-limited until recovery.
            </div>
          )}
          {children}
        </main>
      </div>
    </RealtimeContext.Provider>
  )
}
