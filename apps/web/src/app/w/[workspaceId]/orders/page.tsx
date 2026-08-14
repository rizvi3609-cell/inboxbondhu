'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import { taka, type OrderRow } from '@/lib/types'
import { useRealtime } from '@/lib/realtime-context'

const FULFILLMENT_BADGE: Record<string, string> = {
  Collecting: 'draft', AwaitingConfirmation: 'pending', Confirmed: 'open',
  Processing: 'open', Shipped: 'open', Delivered: 'approved', Cancelled: 'archived',
}

export default function OrdersPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe } = useRealtime()
  const [rows, setRows] = useState<OrderRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const data = await api<{ orders: OrderRow[] }>(`/api/v1/w/${workspaceId}/orders`)
    setRows(data.orders)
    setLoading(false)
  }, [workspaceId])

  useEffect(() => {
    void load().catch((err) => {
      setError(err instanceof ApiFailure ? err.error.message : 'Load failed.')
      setLoading(false)
    })
  }, [load])

  useEffect(
    () => subscribe((event) => {
      if (event === 'order.updated') void load().catch(() => undefined)
    }),
    [subscribe, load],
  )

  async function act(order: OrderRow, action: 'confirm' | 'cancel') {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/orders/${order.id}/${action}`, {
        method: 'POST',
        ...(action === 'cancel' ? { body: { reason: 'agent_cancelled' } } : { body: {} }),
        ifMatch: order.version,
      })
      await load()
    } catch (err) {
      if (err instanceof ApiFailure) {
        if (err.status === 422) setError(`Cannot ${action}: ${err.error.message}`) // e.g. out of stock at confirm (DF-02)
        else if (err.status === 409) {
          setError('The order changed under you — reloaded.')
          await load()
        } else setError(err.error.message)
      } else setError('Request failed.')
    }
  }

  return (
    <div>
      <h1>Orders</h1>
      {error && <p className="error-text">{error}</p>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card muted">No orders yet — the AI drafts them from conversations, or agents create them from the inbox.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Code</th><th>Customer</th><th>Zone</th><th>Total</th><th>Fulfillment</th><th>Payment</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td><strong>{o.orderCode ?? '(draft)'}</strong></td>
                <td>{o.recipientName}</td>
                <td>{o.deliveryZone}</td>
                <td>{taka(o.totalMinor)}</td>
                <td><span className={`badge ${FULFILLMENT_BADGE[o.fulfillmentStatus] ?? 'draft'}`}>{o.fulfillmentStatus}</span></td>
                <td><span className={`badge ${o.paymentStatus === 'Paid' ? 'approved' : 'draft'}`}>{o.paymentStatus}</span></td>
                <td className="muted">{new Date(o.createdAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka' })}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {o.fulfillmentStatus === 'AwaitingConfirmation' && (
                    <button className="primary" onClick={() => void act(o, 'confirm')}>Confirm</button>
                  )}{' '}
                  {!['Cancelled', 'Delivered'].includes(o.fulfillmentStatus) && (
                    <button onClick={() => void act(o, 'cancel')}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
