'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import { taka } from '@/lib/types'

interface Summary {
  conversations: { total: number; aiHandled: number }
  ai: { replies: number; avgLatencyMs: number; costMinor: number; groundingBlocked: number }
  orders: { total: number; confirmed: number; revenueMinor: number; conversionPercent: number }
}

interface Timeseries {
  metric: string
  points: Array<{ day: string; count: number }>
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0' }}>{value}</div>
      {hint && <div className="muted" style={{ fontSize: 12 }}>{hint}</div>}
    </div>
  )
}

export default function AnalyticsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [series, setSeries] = useState<Timeseries | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([
      api<Summary>(`/api/v1/w/${workspaceId}/analytics/summary`),
      api<Timeseries>(`/api/v1/w/${workspaceId}/analytics/timeseries?metric=conversations`),
    ])
      .then(([s, t]) => {
        setSummary(s)
        setSeries(t)
      })
      .catch((err) => setError(err instanceof ApiFailure ? err.error.message : 'Load failed.'))
  }, [workspaceId])

  if (error) return <div><h1>Analytics</h1><p className="error-text">{error}</p></div>
  if (!summary) return <div><h1>Analytics</h1><p className="muted">Loading…</p></div>

  const max = Math.max(1, ...(series?.points.map((p) => p.count) ?? [1]))

  return (
    <div>
      <h1>Analytics <span className="muted" style={{ fontSize: 14 }}>last 30 days · Dhaka time</span></h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Stat label="Conversion rate" value={`${summary.orders.conversionPercent}%`} hint="confirmed orders ÷ conversations — the primary metric" />
        <Stat label="Conversations" value={String(summary.conversations.total)} hint={`${summary.conversations.aiHandled} handled by AI`} />
        <Stat label="Confirmed orders" value={String(summary.orders.confirmed)} hint={`${summary.orders.total} total`} />
        <Stat label="Revenue" value={taka(summary.orders.revenueMinor)} />
        <Stat label="AI replies" value={String(summary.ai.replies)} hint={`avg ${Math.round(summary.ai.avgLatencyMs / 1000)}s · ${summary.ai.groundingBlocked} grounding-blocked`} />
        <Stat label="AI cost" value={taka(summary.ai.costMinor)} hint="this period" />
      </div>
      {series && series.points.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Conversations per day</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
            {series.points.map((p) => (
              <div key={p.day} title={`${p.day}: ${p.count}`} style={{
                flex: 1, minWidth: 4, background: 'var(--brand)', opacity: 0.85,
                height: `${Math.max(3, (p.count / max) * 100)}%`, borderRadius: '3px 3px 0 0',
              }} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
