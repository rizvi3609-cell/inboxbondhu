'use client'

/**
 * F2 — the conversation list (FRONTEND-SPEC §6.1, user-story Act 6).
 * Split-pane left side. Signature animations (§4.2):
 *  - new/updated rows spring in (rowEnter) + brand flash + unread pulse
 *  - handover rows flash amber twice and FLIP to the top (layout prop)
 *  - AI badge breathes; delta merges only (C-8), never full refetch
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ConversationListItemView, RtConversationUpdated, RtMessageCreated } from '@inboxbondhu/contracts/views'
import { api } from '@/lib/api-client'
import { relativeTime } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { useRealtime } from '@/lib/realtime-context'
import { Avatar, Badge, EmptyState, SkeletonRow, Tabs } from '@/components/ui/primitives'

type StatusFilter = 'all' | 'open' | 'pending' | 'resolved'

interface RowMeta {
  /** Which one-shot animation class the row should carry right now. */
  flash: 'new' | 'handover' | null
}

export function ConversationList({ workspaceId, activeId, onSelect }: {
  workspaceId: string
  /** Selected conversation (split-pane); null on mobile list view. */
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const router = useRouter()
  const { subscribe, reconnects } = useRealtime()
  const [rows, setRows] = useState<ConversationListItemView[] | null>(null)
  const [meta, setMeta] = useState<Record<string, RowMeta>>({})
  const [status, setStatus] = useState<StatusFilter>('all')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const lastSyncRef = useRef<string>(new Date(0).toISOString())
  const searchRef = useRef<HTMLInputElement>(null)

  // §6.1 search: 300 ms debounce.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async (mode: 'full' | 'delta') => {
    const qs = new URLSearchParams()
    if (status !== 'all') qs.set('status', status)
    if (debouncedQ) qs.set('q', debouncedQ)
    if (mode === 'delta') qs.set('updatedSince', lastSyncRef.current) // C-8 delta
    const data = await api<{ conversations: ConversationListItemView[] }>(
      `/api/v1/w/${workspaceId}/conversations?${qs.toString()}`,
    )
    lastSyncRef.current = new Date().toISOString()
    setRows((prev) => {
      if (mode === 'full' || prev === null) return data.conversations
      const byId = new Map(prev.map((c) => [c.id, c]))
      for (const c of data.conversations) byId.set(c.id, c)
      return [...byId.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    })
  }, [workspaceId, status, debouncedQ])

  useEffect(() => {
    setRows(null) // filter change → skeleton, then fresh page
    void load('full').catch(() => setRows([]))
  }, [load])

  // Realtime: merge the single conversation, mark its one-shot animation.
  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event === 'message.created') {
          const p = payload as RtMessageCreated
          setMeta((prev) => ({ ...prev, [p.conversationId]: { flash: 'new' } }))
          void load('delta').catch(() => undefined)
        } else if (event === 'conversation.updated') {
          const p = payload as RtConversationUpdated
          // Handover = mode flipped to human by the pipeline (Act 8 flash).
          setMeta((prev) => ({ ...prev, [p.conversationId]: { flash: p.mode === 'human' ? 'handover' : null } }))
          void load('delta').catch(() => undefined)
        }
      }),
    [subscribe, load],
  )
  useEffect(() => {
    if (reconnects > 0) void load('delta').catch(() => undefined)
  }, [reconnects, load])

  // §7.4 keyboard: j/k navigate, Enter open, / focuses search.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (!rows || rows.length === 0) return
      if (e.key === 'j' || e.key === 'k') {
        const idx = rows.findIndex((r) => r.id === activeId)
        const next = e.key === 'j' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1)
        const target = rows[next]
        if (target) onSelect(target.id)
      } else if (e.key === 'Enter' && activeId) {
        router.push(`/w/${workspaceId}/inbox/${activeId}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, activeId, onSelect, router, workspaceId])

  const counts = rows
    ? {
        open: rows.filter((r) => r.status === 'open').length,
        pending: rows.filter((r) => r.status === 'pending').length,
      }
    : { open: 0, pending: 0 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'grid', gap: 10, paddingBottom: 12 }}>
        <Tabs
          tabs={[
            { id: 'all' as const, label: 'All' },
            { id: 'open' as const, label: 'Open', count: counts.open },
            { id: 'pending' as const, label: 'Pending', count: counts.pending },
            { id: 'resolved' as const, label: 'Resolved' },
          ]}
          active={status}
          onChange={setStatus}
        />
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search conversations…  ( / )"
          aria-label="Search conversations"
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'grid', gap: 4, alignContent: 'start' }}>
        {rows === null ? (
          Array.from({ length: 7 }, (_, i) => <SkeletonRow key={i} />)
        ) : rows.length === 0 ? (
          <EmptyState
            icon="💬"
            title={debouncedQ ? 'No matches' : 'No conversations yet'}
            hint={debouncedQ ? 'Try a different search.' : 'Connect a Facebook Page in Settings → Channels and DMs appear here within seconds.'}
          />
        ) : (
          <AnimatePresence initial={false}>
            {rows.map((c) => {
              const flash = meta[c.id]?.flash
              const isActive = c.id === activeId
              return (
                <m.button
                  key={c.id}
                  layout="position"
                  {...rowEnter}
                  onClick={() => onSelect(c.id)}
                  onAnimationEnd={() => {
                    if (flash) setMeta((prev) => ({ ...prev, [c.id]: { flash: null } }))
                  }}
                  className={flash === 'new' ? 'anim-flash' : flash === 'handover' ? 'anim-flash-warn' : undefined}
                  aria-current={isActive ? 'true' : undefined}
                  style={{
                    font: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%',
                    display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px',
                    background: isActive ? 'var(--brand-soft)' : 'var(--panel)',
                    border: `1px solid ${isActive ? 'var(--brand)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-md)',
                    transition: 'background-color var(--dur-fast) ease, border-color var(--dur-fast) ease',
                  }}
                >
                  <Avatar name={c.customer?.displayName ?? 'Customer'} id={c.customer?.id ?? c.id} provider="facebook" />
                  <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.customer?.displayName ?? 'Customer'}
                      </strong>
                      <Badge tone={c.mode} breathing={c.mode === 'ai'}>
                        {c.mode === 'ai' ? '🤖' : '🙋'}
                      </Badge>
                      {c.status !== 'open' && <Badge tone={c.status}>{c.status}</Badge>}
                    </span>
                    <span
                      className="bn muted"
                      style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {c.lastMessageDirection === 'outbound' ? '↩ ' : ''}
                      {c.lastMessagePreview ?? '—'}
                    </span>
                  </span>
                  <span style={{ display: 'grid', gap: 4, justifyItems: 'end', flexShrink: 0 }}>
                    <span className="muted mono-num" style={{ fontSize: 11 }}>{relativeTime(c.lastMessageAt)}</span>
                    {c.unreadCount > 0 && (
                      <span
                        className={flash === 'new' ? 'anim-pulse-once' : undefined}
                        style={{
                          background: 'var(--brand)', color: '#fff', borderRadius: 999,
                          fontSize: 10, fontWeight: 800, padding: '1px 7px',
                        }}
                      >
                        {c.unreadCount}
                      </span>
                    )}
                  </span>
                </m.button>
              )
            })}
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
