'use client'

/**
 * F5 — Analytics (FRONTEND-SPEC §6.6, user-story Act 11 "morning chai"):
 * conversion-rate hero (PRD §1.5 primary metric), the Act 11 overview cards
 * with number tickers, pure-SVG bar series (Dhaka days) with animated
 * growth + tooltips, range picker (7/30/90d), pending-handovers deep link.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { AnalyticsSummaryView, TimeseriesView } from '@inboxbondhu/contracts/views'
import { api } from '@/lib/api-client'
import { taka } from '@/lib/format'
import { m, useReducedMotion } from '@/lib/motion'
import { Skeleton, Tabs } from '@/components/ui/primitives'

type Range = '7' | '30' | '90'
type Metric = TimeseriesView['metric']

/** §4.2 number ticker: counts up once on first view; instant under
 *  prefers-reduced-motion. Pure rAF — no library. */
function Ticker({ value, format = (n: number) => n.toLocaleString() }: {
  value: number
  format?: (n: number) => string
}) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced ? value : 0)
  const done = useRef(false)
  useEffect(() => {
    if (reduced || done.current) {
      setShown(value)
      return
    }
    done.current = true
    const t0 = performance.now()
    const dur = 600
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const eased = 1 - (1 - p) ** 3 // ease-out cubic
      setShown(Math.round(value * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, reduced])
  return <span className="mono-num">{format(shown)}</span>
}

function StatCard({ label, value, hint, format, accent = false }: {
  label: string
  value: number
  hint?: string
  format?: (n: number) => string
  accent?: boolean
}) {
  return (
    <div style={{
      background: 'var(--panel)', border: `1px solid ${accent ? 'var(--brand)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-md)', padding: 16, boxShadow: 'var(--shadow-1)',
    }}>
      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 650 }}>
        {label}
      </div>
      <div style={{ fontSize: accent ? 34 : 26, fontWeight: 800, margin: '4px 0 2px', color: accent ? 'var(--brand-strong)' : 'var(--text)' }}>
        <Ticker value={value} format={format ?? ((n) => n.toLocaleString())} />
      </div>
      {hint && <div className="muted" style={{ fontSize: 11 }}>{hint}</div>}
    </div>
  )
}

/** Pure-SVG bar chart (§3.4 — no chart lib): animated growth, hover tooltip. */
function Bars({ series }: { series: TimeseriesView }) {
  const reduced = useReducedMotion()
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...series.points.map((p) => p.count))
  const W = 720
  const H = 130
  const gap = 3
  const n = Math.max(1, series.points.length)
  const bw = Math.max(4, (W - gap * (n - 1)) / n)

  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label={`${series.metric} per day`}>
        {series.points.map((p, i) => {
          const h = Math.max(3, (p.count / max) * (H - 10))
          return (
            <m.rect
              key={p.day}
              x={i * (bw + gap)}
              width={bw}
              rx={2}
              fill={hover === i ? 'var(--brand-strong)' : 'var(--brand)'}
              opacity={hover === null || hover === i ? 0.9 : 0.45}
              initial={reduced ? { y: H - h, height: h } : { y: H, height: 0 }}
              animate={{ y: H - h, height: h }}
              transition={{ duration: 0.5, delay: reduced ? 0 : Math.min(0.4, i * 0.012), ease: [0.22, 1, 0.36, 1] }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>
      {hover !== null && series.points[hover] && (
        <div style={{
          position: 'absolute', top: -6, left: `${(hover / n) * 100}%`, transform: 'translateX(-50%)',
          background: 'var(--text)', color: 'var(--bg)', borderRadius: 6, padding: '3px 8px',
          fontSize: 11, fontWeight: 650, whiteSpace: 'nowrap', pointerEvents: 'none',
        }} className="mono-num">
          {series.points[hover].day} · {series.points[hover].count}
        </div>
      )}
    </div>
  )
}

export default function AnalyticsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [range, setRange] = useState<Range>('30')
  const [metric, setMetric] = useState<Metric>('conversations')
  const [summary, setSummary] = useState<AnalyticsSummaryView | null>(null)
  const [series, setSeries] = useState<TimeseriesView | null>(null)

  const load = useCallback(async () => {
    const to = new Date()
    const from = new Date(to.getTime() - Number(range) * 86_400_000)
    const qs = `from=${from.toISOString()}&to=${to.toISOString()}`
    const [s, t] = await Promise.all([
      api<AnalyticsSummaryView>(`/api/v1/w/${workspaceId}/analytics/summary?${qs}`),
      api<TimeseriesView>(`/api/v1/w/${workspaceId}/analytics/timeseries?metric=${metric}&${qs}`),
    ])
    setSummary(s)
    setSeries(t)
  }, [workspaceId, range, metric])

  useEffect(() => {
    setSummary(null)
    setSeries(null)
    void load().catch(() => undefined)
  }, [load])

  return (
    <div style={{ maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>
          Analytics <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>Dhaka time</span>
        </h1>
        <div style={{ marginLeft: 'auto' }}>
          <Tabs
            tabs={[
              { id: '7' as const, label: '7 days' },
              { id: '30' as const, label: '30 days' },
              { id: '90' as const, label: '90 days' },
            ]}
            active={range}
            onChange={setRange}
          />
        </div>
      </div>

      {summary === null ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={92} radius={12} />)}
        </div>
      ) : (
        <>
          {/* PRD §1.5 primary metric — the hero */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
            <StatCard
              accent
              label="Conversion rate"
              value={summary.orders.conversionPercent}
              format={(v) => `${v}%`}
              hint="confirmed orders ÷ conversations — the number that pays the bills"
            />
            <StatCard
              label="Revenue"
              value={summary.orders.revenueMinor}
              format={(v) => taka(v)}
              hint={`${summary.orders.confirmed} confirmed of ${summary.orders.total} orders`}
            />
          </div>

          {/* Act 11: the morning-chai overview */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
            <StatCard
              label="Conversations"
              value={summary.conversations.total}
              hint={summary.conversations.total > 0
                ? `${Math.round((summary.conversations.aiHandled / summary.conversations.total) * 100)}% handled by AI`
                : 'none this period'}
            />
            <StatCard label="AI replies sent" value={summary.ai.replies}
              hint={`avg ${(summary.ai.avgLatencyMs / 1000).toFixed(1)}s first response`} />
            <StatCard label="Grounding blocked" value={summary.ai.groundingBlocked}
              hint="answers the AI refused to invent" />
            <StatCard label="AI cost" value={summary.ai.costMinor} format={(v) => taka(v)} hint="this period" />
          </div>

          {/* Handover attention card (Act 11 "⚠ 2 handovers pending") */}
          {summary.conversations.total - summary.conversations.aiHandled > 0 && (
            <Link href={`/w/${workspaceId}/inbox`} style={{ textDecoration: 'none' }}>
              <div style={{
                marginTop: 12, background: 'var(--warn-soft)', border: '1px solid var(--warn)',
                borderRadius: 'var(--radius-md)', padding: '10px 16px', fontSize: 13,
                display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)',
              }}>
                ⚠️ <strong>{summary.conversations.total - summary.conversations.aiHandled}</strong>
                conversations needed a human this period — review them in the inbox →
              </div>
            </Link>
          )}

          <div style={{
            marginTop: 16, background: 'var(--panel)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)', padding: 16,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <h3 style={{ margin: 0 }}>Per day</h3>
              <div style={{ marginLeft: 'auto' }}>
                <Tabs
                  tabs={[
                    { id: 'conversations' as const, label: 'Conversations' },
                    { id: 'orders' as const, label: 'Orders' },
                    { id: 'ai_replies' as const, label: 'AI replies' },
                  ]}
                  active={metric}
                  onChange={setMetric}
                />
              </div>
            </div>
            {series === null ? (
              <Skeleton height={130} radius={8} />
            ) : series.points.length === 0 ? (
              <p className="muted" style={{ textAlign: 'center', padding: 24 }}>No data in this range yet.</p>
            ) : (
              <Bars series={series} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
