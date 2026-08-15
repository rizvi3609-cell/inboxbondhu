'use client'

/**
 * F3 — Orders (FRONTEND-SPEC §6.3): table on desktop / cards on mobile,
 * state-machine actions driven by FULFILLMENT_TRANSITIONS truth, oversell
 * 422 surfaced clearly (DF-02 wording), order.updated socket → badge
 * crossfade, cancel-with-reason dialog, detail expansion.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { OrderView, RtOrderUpdated } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { dhakaDate, taka } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { useRealtime } from '@/lib/realtime-context'
import { Badge, Button, EmptyState, Tabs } from '@/components/ui/primitives'
import { Dialog, useToast } from '@/components/ui/overlay'

type FulfillFilter = 'all' | 'AwaitingConfirmation' | 'Confirmed' | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'

/** Mirror of the server's FULFILLMENT_TRANSITIONS — which buttons to show.
 *  UI sugar only (C-9); the service re-validates every transition. */
const NEXT_ACTIONS: Record<string, Array<{ to: string; label: string; primary?: boolean }>> = {
  AwaitingConfirmation: [{ to: 'confirm', label: 'Confirm', primary: true }],
  Confirmed: [{ to: 'Processing', label: 'Start processing' }],
  Processing: [{ to: 'Shipped', label: 'Mark shipped' }],
  Shipped: [{ to: 'Delivered', label: 'Mark delivered', primary: true }],
}

const CANCELLABLE = new Set(['Collecting', 'AwaitingConfirmation', 'Confirmed', 'Processing'])

export default function OrdersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe, reconnects } = useRealtime()
  const { toast } = useToast()
  const [rows, setRows] = useState<OrderView[] | null>(null)
  const [filter, setFilter] = useState<FulfillFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [cancelTarget, setCancelTarget] = useState<OrderView | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  const [shakeId, setShakeId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const qs = filter === 'all' ? '' : `?fulfillmentStatus=${filter}`
    const data = await api<{ orders: OrderView[] }>(`/api/v1/w/${workspaceId}/orders${qs}`)
    setRows(data.orders)
  }, [workspaceId, filter])

  useEffect(() => {
    setRows(null)
    void load().catch(() => setRows([]))
  }, [load])

  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event !== 'order.updated') return
        const p = payload as RtOrderUpdated
        setFlashId(p.orderId) // §4.2: badge crossfade + row glow
        void load().catch(() => undefined)
      }),
    [subscribe, load],
  )
  useEffect(() => {
    if (reconnects > 0) void load().catch(() => undefined)
  }, [reconnects, load])

  async function act(order: OrderView, action: string) {
    setBusyId(order.id)
    try {
      if (action === 'confirm') {
        // T1 — NEVER optimistic (§5.2.6): the stock race decides, not the UI.
        await api(`/api/v1/w/${workspaceId}/orders/${order.id}/confirm`, { method: 'POST', body: {} })
        toast('success', `Order ${order.orderCode ?? ''} confirmed — stock reserved.`)
      } else {
        // Ship/Deliver/Processing via PATCH + If-Match (OCC).
        await api(`/api/v1/w/${workspaceId}/orders/${order.id}`, {
          method: 'PATCH', body: { fulfillmentStatus: action }, ifMatch: order.version,
        })
        toast('success', `Order marked ${action}.`)
      }
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 422) {
        // DF-02: the out-of-stock race — surface it CLEARLY, never drop it.
        setShakeId(order.id)
        setTimeout(() => setShakeId(null), 400)
        toast('error', `Cannot confirm: ${err.error.message}`, err.error.requestId)
      } else if (err instanceof ApiFailure && err.status === 409) {
        toast('warn', 'This order changed under you — refreshed.')
        await load()
      } else if (err instanceof ApiFailure && err.status === 403) {
        toast('error', 'You don\u2019t have permission for that transition.')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Action failed.')
      }
    } finally {
      setBusyId(null)
    }
  }

  async function doCancel() {
    if (!cancelTarget || !cancelReason.trim()) return
    setBusyId(cancelTarget.id)
    try {
      await api(`/api/v1/w/${workspaceId}/orders/${cancelTarget.id}/cancel`, {
        method: 'POST', body: { reason: cancelReason.trim() },
      })
      toast('success', 'Order cancelled — reservations released.')
      setCancelTarget(null)
      setCancelReason('')
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 403) {
        toast('error', 'Cancelling a Processing order needs an owner or admin.')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Cancel failed.')
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Orders</h1>
        <div style={{ marginLeft: 'auto' }}>
          <Tabs
            tabs={[
              { id: 'all' as const, label: 'All' },
              { id: 'AwaitingConfirmation' as const, label: 'Awaiting' },
              { id: 'Confirmed' as const, label: 'Confirmed' },
              { id: 'Processing' as const, label: 'Processing' },
              { id: 'Shipped' as const, label: 'Shipped' },
              { id: 'Delivered' as const, label: 'Delivered' },
            ]}
            active={filter}
            onChange={setFilter}
          />
        </div>
      </div>

      {rows === null ? null /* loading.tsx streams the skeleton */ : rows.length === 0 ? (
        <EmptyState
          icon="📦"
          title={filter === 'all' ? 'No orders yet' : `No ${filter} orders`}
          hint="The AI drafts orders from conversations; agents can also create them from a thread."
        />
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          <AnimatePresence initial={false}>
            {rows.map((o) => {
              const actions = NEXT_ACTIONS[o.fulfillmentStatus] ?? []
              const isOpen = expanded === o.id
              return (
                <m.div
                  key={o.id}
                  layout="position"
                  {...rowEnter}
                  className={flashId === o.id ? 'anim-flash' : shakeId === o.id ? 'anim-shake' : undefined}
                  onAnimationEnd={() => {
                    if (flashId === o.id) setFlashId(null)
                  }}
                  style={{
                    background: 'var(--panel)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)', overflow: 'hidden',
                  }}
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : o.id)}
                    aria-expanded={isOpen}
                    style={{
                      font: 'inherit', width: '100%', textAlign: 'left', cursor: 'pointer',
                      background: 'none', border: 'none', padding: '12px 14px',
                      display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                    }}
                  >
                    <strong className="mono-num" style={{ minWidth: 118 }}>{o.orderCode ?? '(draft)'}</strong>
                    <span style={{ flex: 1, minWidth: 120 }}>
                      {o.recipientName} <span className="muted">· {o.deliveryZone}</span>
                    </span>
                    <span className="mono-num" style={{ fontWeight: 700, color: 'var(--accent)' }}>{taka(o.totalMinor)}</span>
                    {/* §4.2 badge crossfade on status change */}
                    <AnimatePresence mode="popLayout" initial={false}>
                      <m.span
                        key={o.fulfillmentStatus}
                        initial={{ opacity: 0, scale: 1.15 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        transition={{ duration: 0.2 }}
                      >
                        <Badge tone={o.fulfillmentStatus}>{o.fulfillmentStatus}</Badge>
                      </m.span>
                    </AnimatePresence>
                    <Badge tone={o.paymentStatus}>{o.paymentStatus}</Badge>
                    <span className="muted mono-num" style={{ fontSize: 11 }}>
                      {o.createdAt ? dhakaDate(o.createdAt) : '—'}
                    </span>
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
                          <table style={{ fontSize: 12 }}>
                            <thead>
                              <tr><th>Item</th><th>Variant</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Line</th></tr>
                            </thead>
                            <tbody>
                              {o.items.map((it, i) => (
                                <tr key={i}>
                                  <td>{it.nameSnapshot}</td>
                                  <td className="muted">{it.variantNameSnapshot} · {it.variantSku}</td>
                                  <td className="mono-num" style={{ textAlign: 'right' }}>{it.quantity}</td>
                                  <td className="mono-num" style={{ textAlign: 'right' }}>{taka(it.lineTotalMinor)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div style={{ display: 'flex', gap: 18, fontSize: 12, flexWrap: 'wrap' }}>
                            <span className="muted">Subtotal <strong className="mono-num" style={{ color: 'var(--text)' }}>{taka(o.subtotalMinor)}</strong></span>
                            {o.discountMinor > 0 && <span className="muted">Discount <strong className="mono-num" style={{ color: 'var(--ok)' }}>−{taka(o.discountMinor)}</strong></span>}
                            <span className="muted">Delivery <strong className="mono-num" style={{ color: 'var(--text)' }}>{taka(o.deliveryFeeMinor)}</strong></span>
                            <span className="muted">Total <strong className="mono-num" style={{ color: 'var(--accent)' }}>{taka(o.totalMinor)}</strong></span>
                            <span className="muted" style={{ marginLeft: 'auto' }}>
                              {o.recipientPhone} · <span className="bn">{o.deliveryAddress}</span>
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <Link href={`/w/${workspaceId}/inbox/${o.conversationId}`} style={{ fontSize: 12 }}>
                              💬 View conversation
                            </Link>
                            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                              {actions.map((a) => (
                                <Button
                                  key={a.to}
                                  small
                                  variant={a.primary ? 'primary' : 'ghost'}
                                  loading={busyId === o.id}
                                  onClick={() => void act(o, a.to)}
                                >
                                  {a.label}
                                </Button>
                              ))}
                              {CANCELLABLE.has(o.fulfillmentStatus) && (
                                <Button small variant="danger" onClick={() => setCancelTarget(o)}>
                                  Cancel
                                </Button>
                              )}
                            </span>
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

      <Dialog
        open={cancelTarget !== null}
        onClose={() => setCancelTarget(null)}
        title={`Cancel ${cancelTarget?.orderCode ?? 'this order'}?`}
      >
        <p className="muted" style={{ marginTop: 0 }}>
          Reserved stock is released immediately. The cancellation is recorded in the order history and audit log.
          {cancelTarget?.fulfillmentStatus === 'Processing' && (
            <> <strong>Processing orders can only be cancelled by an owner or admin.</strong></>
          )}
        </p>
        <label>
          Reason (required)
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} maxLength={500} autoFocus />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <Button onClick={() => setCancelTarget(null)}>Keep order</Button>
          <Button variant="danger" loading={busyId === cancelTarget?.id} disabled={!cancelReason.trim()} onClick={() => void doCancel()}>
            Cancel order
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
