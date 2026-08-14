'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { api } from '@/lib/api-client'
import type { ConversationRow } from '@/lib/types'
import { useRealtime } from '@/lib/realtime-context'

export default function InboxPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe, reconnects } = useRealtime()
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [status, setStatus] = useState<'all' | 'open' | 'pending' | 'resolved'>('all')
  const [loading, setLoading] = useState(true)
  const lastSyncRef = useRef<string>(new Date(0).toISOString())

  const load = useCallback(async (full: boolean) => {
    const qs = new URLSearchParams()
    if (status !== 'all') qs.set('status', status)
    if (!full) qs.set('updatedSince', lastSyncRef.current) // P-08 cheap reconcile
    const data = await api<{ conversations: ConversationRow[] }>(
      `/api/v1/w/${workspaceId}/conversations?${qs.toString()}`,
    )
    lastSyncRef.current = new Date().toISOString()
    setRows((prev) => {
      if (full) return data.conversations
      const byId = new Map(prev.map((c) => [c.id, c]))
      for (const c of data.conversations) byId.set(c.id, c)
      return [...byId.values()].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    })
    setLoading(false)
  }, [workspaceId, status])

  useEffect(() => {
    setLoading(true)
    void load(true).catch(() => setLoading(false))
  }, [load])

  // Realtime: ids+preview payloads → merge or refetch the delta.
  useEffect(
    () =>
      subscribe((event) => {
        if (event === 'message.created' || event === 'conversation.updated') {
          void load(false).catch(() => undefined)
        }
      }),
    [subscribe, load],
  )
  // Reconnect → one cheap updatedSince query, never a full refetch (P-08).
  useEffect(() => {
    if (reconnects > 0) void load(false).catch(() => undefined)
  }, [reconnects, load])

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Inbox</h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {(['all', 'open', 'pending', 'resolved'] as const).map((s) => (
            <button key={s} onClick={() => setStatus(s)} className={s === status ? 'primary' : ''}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <p className="muted">Loading conversations…</p>
      ) : rows.length === 0 ? (
        <div className="card muted">No conversations yet. Connect a Facebook Page in Settings → Channels and DMs will appear here.</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((c) => (
            <Link key={c.id} href={`/w/${workspaceId}/inbox/${c.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong>{c.customer?.displayName ?? c.customerName ?? 'Customer'}</strong>
                    <span className={`badge ${c.mode}`}>{c.mode === 'ai' ? 'AI' : 'Human'}</span>
                    <span className={`badge ${c.status}`}>{c.status}</span>
                    {c.unreadCount > 0 && <span className="badge pending">{c.unreadCount} new</span>}
                  </div>
                  <div className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.lastMessageDirection === 'outbound' ? '↩ ' : ''}
                    {c.lastMessagePreview ?? '—'}
                  </div>
                </div>
                <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {new Date(c.lastMessageAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
