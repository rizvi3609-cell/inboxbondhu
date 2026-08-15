'use client'

/**
 * F4 — Settings → Audit log (prd §4.6 — the queryable audit UI that never
 * existed): filters for action prefix / resource type / actor / date range,
 * cursor pagination ("Load more"), requestId copy button, before/after
 * expansion. content-visibility keeps long lists cheap (§5.2 item 5).
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { AuditLogView } from '@inboxbondhu/contracts/views'
import { api } from '@/lib/api-client'
import { dhakaDateTime } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { Badge, Button, EmptyState, SkeletonRow } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'

interface AuditRow extends AuditLogView {
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}

const RESOURCE_TYPES = ['', 'conversation', 'message', 'order', 'product', 'knowledgeItem', 'workspace', 'membership', 'invitation', 'channelConnection', 'user'] as const

const ACTOR_TONE: Record<string, 'ai' | 'brand' | 'neutral'> = { ai: 'ai', user: 'brand', system: 'neutral' }

export default function AuditPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  // filters
  const [action, setAction] = useState('')
  const [resourceType, setResourceType] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const buildQs = useCallback((cur: string | null) => {
    const qs = new URLSearchParams()
    if (action.trim()) qs.set('action', action.trim())
    if (resourceType) qs.set('resourceType', resourceType)
    if (from) qs.set('from', new Date(from).toISOString())
    if (to) qs.set('to', new Date(`${to}T23:59:59`).toISOString())
    if (cur) qs.set('cursor', cur)
    qs.set('limit', '50')
    return qs.toString()
  }, [action, resourceType, from, to])

  const load = useCallback(async (cur: string | null) => {
    const data = await api<{ logs: AuditRow[]; nextCursor: string | null }>(
      `/api/v1/w/${workspaceId}/audit-logs?${buildQs(cur)}`,
    )
    setRows((prev) => (cur && prev ? [...prev, ...data.logs] : data.logs))
    setCursor(data.nextCursor)
  }, [workspaceId, buildQs])

  useEffect(() => {
    setRows(null)
    const t = setTimeout(() => void load(null).catch(() => setRows([])), 250) // debounce filters
    return () => clearTimeout(t)
  }, [load])

  async function more() {
    setLoadingMore(true)
    await load(cursor).catch(() => undefined)
    setLoadingMore(false)
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* Filter bar (prd §4.6: actor, action type, entity type, date range) */}
      <div style={{
        background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        padding: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end',
      }}>
        <label style={{ flex: 1, minWidth: 160, marginBottom: 0 }}>
          Action prefix
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. order. / ai. / member." />
        </label>
        <label style={{ width: 170, marginBottom: 0 }}>
          Resource
          <select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
            {RESOURCE_TYPES.map((r) => <option key={r} value={r}>{r || 'any'}</option>)}
          </select>
        </label>
        <label style={{ width: 150, marginBottom: 0 }}>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label style={{ width: 150, marginBottom: 0 }}>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {(action || resourceType || from || to) && (
          <Button small onClick={() => { setAction(''); setResourceType(''); setFrom(''); setTo('') }}>
            Clear
          </Button>
        )}
      </div>

      {rows === null ? (
        <div>{Array.from({ length: 6 }, (_, i) => <SkeletonRow key={i} />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon="🗂️" title="No audit entries match" hint="Every auth event, role change, order transition, discount, and AI handover lands here." />
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          <AnimatePresence initial={false}>
            {rows.map((r) => {
              const isOpen = expanded === r.id
              const hasDiff = (r.before && Object.keys(r.before).length > 0) || (r.after && Object.keys(r.after).length > 0)
              return (
                <m.div
                  key={r.id}
                  {...rowEnter}
                  style={{
                    background: 'var(--panel)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)', overflow: 'hidden',
                    contentVisibility: 'auto', containIntrinsicSize: 'auto 44px',
                  }}
                >
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', fontSize: 12, flexWrap: 'wrap' }}>
                    <span className="muted mono-num" style={{ minWidth: 118 }}>{dhakaDateTime(r.createdAt)}</span>
                    <Badge tone={ACTOR_TONE[r.actorType] ?? 'neutral'}>
                      {r.actorType === 'ai' ? '🤖' : r.actorType === 'system' ? '⚙' : r.actorRole ?? 'user'}
                    </Badge>
                    <strong className="mono-num">{r.action}</strong>
                    <span className="muted">{r.resourceType}/{r.resourceId.slice(-6)}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      {hasDiff && (
                        <Button small onClick={() => setExpanded(isOpen ? null : r.id)}>
                          {isOpen ? 'Hide' : 'Diff'}
                        </Button>
                      )}
                      <Button
                        small
                        title="Copy requestId — pair it with server logs"
                        onClick={() => {
                          void navigator.clipboard?.writeText(r.requestId)
                          toast('info', 'requestId copied.')
                        }}
                      >
                        ⧉ req
                      </Button>
                    </span>
                  </div>
                  <AnimatePresence initial={false}>
                    {isOpen && hasDiff && (
                      <m.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        style={{ overflow: 'hidden', borderTop: '1px solid var(--border)' }}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '10px 12px', fontSize: 11 }}>
                          <div>
                            <div className="muted" style={{ fontWeight: 700, marginBottom: 4 }}>BEFORE</div>
                            <pre className="mono-num" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--warn)' }}>
                              {r.before ? JSON.stringify(r.before, null, 1) : '—'}
                            </pre>
                          </div>
                          <div>
                            <div className="muted" style={{ fontWeight: 700, marginBottom: 4 }}>AFTER</div>
                            <pre className="mono-num" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ok)' }}>
                              {r.after ? JSON.stringify(r.after, null, 1) : '—'}
                            </pre>
                          </div>
                        </div>
                      </m.div>
                    )}
                  </AnimatePresence>
                </m.div>
              )
            })}
          </AnimatePresence>
          {cursor && (
            <div style={{ textAlign: 'center', padding: 8 }}>
              <Button loading={loadingMore} onClick={() => void more()}>Load more</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
