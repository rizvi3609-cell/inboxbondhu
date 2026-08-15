'use client'

/**
 * F3 — Catalogue (FRONTEND-SPEC §6.4): drag-drop CSV import zone (dashed
 * border animates on drag-over), live progress via the import.progress
 * socket + poll fallback, per-row error report expandable after completion
 * (US-012), variants expander with animated height, archive → restore,
 * PLAN_LIMIT_EXCEEDED → upgrade CTA.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { useParams } from 'next/navigation'
import type { ImportView, ProductView, RtImportProgress } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { taka } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { useRealtime } from '@/lib/realtime-context'
import { Badge, Button, CheckDraw, EmptyState, Tabs } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'

type StatusFilter = 'all' | 'active' | 'draft' | 'archived'

export default function CataloguePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe, reconnects } = useRealtime()
  const { toast } = useToast()
  const [rows, setRows] = useState<ProductView[] | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [imp, setImp] = useState<ImportView | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    const data = await api<{ products: ProductView[] }>(`/api/v1/w/${workspaceId}/products`)
    setRows(data.products)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => setRows([]))
  }, [load])
  useEffect(() => {
    if (reconnects > 0) void load().catch(() => undefined)
  }, [reconnects, load])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const refreshImport = useCallback(async (importId: string) => {
    const status = await api<ImportView>(`/api/v1/w/${workspaceId}/imports/${importId}`)
    setImp(status)
    if (['completed', 'failed', 'cancelled'].includes(status.status)) {
      stopPolling()
      void load()
    }
  }, [workspaceId, stopPolling, load])

  // Live progress: socket first (F2 pipeline), poll as the §12.4 fallback.
  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event !== 'import.progress') return
        const p = payload as RtImportProgress
        setImp((prev) => (prev && p.importId === prev.id
          ? { ...prev, status: p.status as ImportView['status'], lastProcessedRow: p.lastProcessedRow, totalRows: p.totalRows, successCount: p.successCount, failureCount: p.failureCount }
          : prev))
        if (p.status === 'completed') {
          stopPolling()
          void refreshImport(p.importId).catch(() => undefined) // pull errors[]
        }
      }),
    [subscribe, stopPolling, refreshImport],
  )
  useEffect(() => stopPolling, [stopPolling])

  async function uploadCsv(file: File) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast('warn', 'Only .csv files are accepted.')
      return
    }
    try {
      const content = await file.text() // strict UTF-8 verified server-side
      const started = await api<{ importId: string; totalRows: number }>(
        `/api/v1/w/${workspaceId}/products/import`,
        { method: 'POST', body: { fileName: file.name, content, encoding: 'utf8' } },
      )
      setShowErrors(false)
      setImp({
        id: started.importId, fileName: file.name, status: 'processing',
        totalRows: started.totalRows, lastProcessedRow: 0, successCount: 0, failureCount: 0,
        errors: [], startedAt: null, completedAt: null,
      })
      stopPolling()
      pollRef.current = setInterval(() => void refreshImport(started.importId).catch(stopPolling), 2_000)
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'PLAN_LIMIT_EXCEEDED') {
        toast('error', `${err.error.message} Upgrade your plan to import more products.`)
      } else if (err instanceof ApiFailure && err.error.code === 'RATE_LIMITED') {
        toast('warn', 'Import limit reached (5 per hour per workspace). Try again later.')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Import failed to start.')
      }
    }
  }

  async function cancelImport() {
    if (!imp) return
    await api(`/api/v1/w/${workspaceId}/imports/${imp.id}/cancel`, { method: 'POST' }).catch(() => undefined)
    toast('info', 'Cancelling at the next checkpoint…')
  }

  async function archive(p: ProductView) {
    setBusyId(p.id)
    try {
      await api(`/api/v1/w/${workspaceId}/products/${p.id}`, { method: 'DELETE', ifMatch: p.version })
      toast('success', `${p.name} archived — the AI stops offering it.`)
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Archive failed.')
    } finally {
      setBusyId(null)
    }
  }

  async function restore(p: ProductView) {
    setBusyId(p.id)
    try {
      await api(`/api/v1/w/${workspaceId}/products/${p.id}`, {
        method: 'PATCH', body: { status: 'active' }, ifMatch: p.version,
      })
      toast('success', `${p.name} restored to active.`)
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'PLAN_LIMIT_EXCEEDED') {
        toast('error', `${err.error.message} Upgrade to restore more products.`)
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Restore failed.')
      }
    } finally {
      setBusyId(null)
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) void uploadCsv(file)
  }

  const visible = rows?.filter((p) => filter === 'all' || p.status === filter) ?? null
  const running = imp && ['pending', 'processing'].includes(imp.status)
  const pct = imp && imp.totalRows > 0 ? Math.round((imp.lastProcessedRow / imp.totalRows) * 100) : 0

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Catalogue</h1>
        <div style={{ marginLeft: 'auto' }}>
          <Tabs
            tabs={[
              { id: 'all' as const, label: 'All' },
              { id: 'active' as const, label: 'Active' },
              { id: 'draft' as const, label: 'Draft' },
              { id: 'archived' as const, label: 'Archived' },
            ]}
            active={filter}
            onChange={setFilter}
          />
        </div>
      </div>

      {/* §6.4 drag-drop import zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragOver ? 'var(--brand)' : 'var(--border-strong)'}`,
          background: dragOver ? 'var(--brand-soft)' : 'var(--panel)',
          borderRadius: 'var(--radius-md)', padding: '14px 16px', marginBottom: 14,
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          transition: 'border-color var(--dur-base) ease, background-color var(--dur-base) ease, transform var(--dur-base) var(--ease-out-soft)',
          transform: dragOver ? 'scale(1.005)' : 'scale(1)',
        }}
      >
        <span style={{ fontSize: 22 }}>📄</span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <strong>Import products from CSV</strong>
          <div className="muted" style={{ fontSize: 12 }}>
            Drop a file here or browse · columns: sku, name, price, stock… · up to 5,000 rows · resumable
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void uploadCsv(f)
            e.target.value = ''
          }}
        />
        <Button variant="primary" onClick={() => fileRef.current?.click()}>Browse…</Button>
      </div>

      {/* Import progress card (§4.2: bar springs to checkpoints; ✓ draw-in) */}
      <AnimatePresence>
        {imp && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden', marginBottom: 14 }}
          >
            <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {imp.status === 'completed' ? <CheckDraw /> : running ? <span className="muted">⏳</span> : <span>⚠️</span>}
                <strong>{imp.fileName}</strong>
                <Badge tone={imp.status}>{imp.status}</Badge>
                <span className="mono-num muted" style={{ fontSize: 12 }}>
                  {imp.lastProcessedRow}/{imp.totalRows} rows
                  {imp.failureCount > 0 && <> · <span style={{ color: 'var(--danger)' }}>{imp.failureCount} errors</span></>}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {running && <Button small onClick={() => void cancelImport()}>Cancel</Button>}
                  {imp.failureCount > 0 && !running && (
                    <Button small onClick={() => setShowErrors((s) => !s)}>
                      {showErrors ? 'Hide' : 'Show'} error report
                    </Button>
                  )}
                  {!running && <Button small onClick={() => setImp(null)}>Dismiss</Button>}
                </span>
              </div>
              <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${imp.status === 'completed' ? 100 : pct}%`,
                  background: imp.status === 'failed' ? 'var(--danger)' : 'var(--brand)',
                  borderRadius: 4, transition: 'width 500ms var(--ease-out-soft)',
                }} />
              </div>
              <AnimatePresence>
                {showErrors && imp.errors.length > 0 && (
                  <m.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    {/* US-012: the per-row error report */}
                    <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                      <table style={{ fontSize: 12 }}>
                        <thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
                        <tbody>
                          {imp.errors.map((e, i) => (
                            <tr key={i}>
                              <td className="mono-num">{e.row}</td>
                              <td>{e.column}</td>
                              <td className="error-text">{e.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {visible === null ? null : visible.length === 0 ? (
        <EmptyState
          icon="🏷️"
          title={filter === 'all' ? 'No products yet' : `No ${filter} products`}
          hint="Import a CSV above — the AI can only quote products that exist here."
        />
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <AnimatePresence initial={false}>
            {visible.map((p) => {
              const stock = p.variants.reduce((s, v) => s + v.stock, 0)
              const reserved = p.variants.reduce((s, v) => s + v.reserved, 0)
              const isOpen = expanded === p.id
              return (
                <m.div key={p.id} layout="position" {...rowEnter} style={{
                  background: 'var(--panel)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', overflow: 'hidden',
                  opacity: p.status === 'archived' ? 0.65 : 1,
                }}>
                  <button
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    aria-expanded={isOpen}
                    style={{
                      font: 'inherit', width: '100%', textAlign: 'left', cursor: 'pointer',
                      background: 'none', border: 'none', padding: '12px 14px',
                      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                    }}
                  >
                    <span className="mono-num muted" style={{ minWidth: 90, fontSize: 12 }}>{p.sku}</span>
                    <strong style={{ flex: 1, minWidth: 140 }}>{p.name}</strong>
                    <span className="mono-num" style={{ fontWeight: 700, color: 'var(--accent)' }}>{taka(p.basePriceMinor)}</span>
                    <span className="mono-num" style={{ fontSize: 12 }}>
                      {stock} in stock
                      {reserved > 0 && <span className="muted"> ({reserved} reserved)</span>}
                    </span>
                    <Badge tone={p.status}>{p.status}</Badge>
                  </button>
                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <m.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        style={{ overflow: 'hidden', borderTop: '1px solid var(--border)' }}
                      >
                        <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
                          {p.description && <p className="muted bn" style={{ margin: 0, fontSize: 12 }}>{p.description}</p>}
                          <table style={{ fontSize: 12 }}>
                            <thead><tr><th>Variant</th><th>SKU</th><th style={{ textAlign: 'right' }}>Stock</th><th style={{ textAlign: 'right' }}>Reserved</th><th style={{ textAlign: 'right' }}>Available</th></tr></thead>
                            <tbody>
                              {p.variants.map((v) => (
                                <tr key={v.sku} style={{ opacity: v.isActive ? 1 : 0.5 }}>
                                  <td>{v.name}</td>
                                  <td className="mono-num muted">{v.sku}</td>
                                  <td className="mono-num" style={{ textAlign: 'right' }}>{v.stock}</td>
                                  <td className="mono-num" style={{ textAlign: 'right' }}>{v.reserved}</td>
                                  <td className="mono-num" style={{ textAlign: 'right', fontWeight: 700, color: v.stock - v.reserved <= 0 ? 'var(--danger)' : 'var(--ok)' }}>
                                    {v.stock - v.reserved}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                            {p.status === 'archived' ? (
                              <Button small variant="primary" loading={busyId === p.id} onClick={() => void restore(p)}>Restore</Button>
                            ) : (
                              <Button small variant="danger" loading={busyId === p.id} onClick={() => void archive(p)}>Archive</Button>
                            )}
                          </div>
                        </div>
                      </m.div>
                    )}
                  </AnimatePresence>
                </m.div>
              )
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
