'use client'

/**
 * F4 — Settings → Business hours (§6.7): master toggle, 7-day grid (closed
 * chips + time pickers), Bengali away-message textarea with a behaviour
 * preview (P-09: sent at most once per customer per day). If-Match save.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { WorkspaceView } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { Button, Skeleton } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'

type Hours = WorkspaceView['businessHours']
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function BusinessHoursPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [ws, setWs] = useState<WorkspaceView | null>(null)
  const [form, setForm] = useState<Hours | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await api<WorkspaceView>(`/api/v1/w/${workspaceId}`)
    setWs(data)
    setForm(JSON.parse(JSON.stringify(data.businessHours)) as Hours)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  const dirty = ws && form && JSON.stringify(form) !== JSON.stringify(ws.businessHours)

  async function save() {
    if (!ws || !form) return
    setBusy(true)
    try {
      await api(`/api/v1/w/${workspaceId}/settings/business-hours`, {
        method: 'PATCH',
        body: { enabled: form.enabled, days: form.days, awayMessage: form.awayMessage ?? null },
        ifMatch: ws.version,
      })
      toast('success', 'Business hours saved.')
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        toast('warn', 'Settings changed elsewhere — reloaded the current values.')
        await load()
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Save failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  function setDay(i: number, patch: Partial<Hours['days'][number]>) {
    if (!form) return
    const days = form.days.map((d, idx) => (idx === i ? { ...d, ...patch } : d))
    setForm({ ...form, days })
  }

  if (!form || !ws) {
    return <div style={{ display: 'grid', gap: 12 }}><Skeleton height={60} radius={12} /><Skeleton height={260} radius={12} /></div>
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 0, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          style={{ width: 'auto', accentColor: 'var(--brand)' }}
        />
        <span>
          <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13 }}>Enable business hours</span>
          <span className="muted" style={{ display: 'block', fontSize: 12 }}>
            Outside these hours the AI sends your away message instead of answering.
          </span>
        </span>
      </label>

      <div style={{
        background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        padding: 14, display: 'grid', gap: 8, opacity: form.enabled ? 1 : 0.55,
        transition: 'opacity var(--dur-base) ease',
      }}>
        {form.days.map((d, i) => (
          <div key={d.day} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setDay(i, { closed: !d.closed })}
              aria-pressed={!d.closed}
              style={{
                font: 'inherit', width: 52, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                padding: '5px 0', borderRadius: 'var(--radius-sm)',
                border: `1px solid ${d.closed ? 'var(--border)' : 'var(--brand)'}`,
                background: d.closed ? 'var(--panel-2)' : 'var(--brand-soft)',
                color: d.closed ? 'var(--muted)' : 'var(--brand-strong)',
                transition: 'all var(--dur-fast) ease',
              }}
            >
              {DAY_NAMES[d.day]}
            </button>
            {d.closed ? (
              <span className="muted" style={{ fontSize: 12 }}>Closed</span>
            ) : (
              <>
                <input type="time" value={d.open} onChange={(e) => setDay(i, { open: e.target.value })} style={{ width: 110 }} aria-label={`${DAY_NAMES[d.day]} opens`} />
                <span className="muted">→</span>
                <input type="time" value={d.close} onChange={(e) => setDay(i, { close: e.target.value })} style={{ width: 110 }} aria-label={`${DAY_NAMES[d.day]} closes`} />
                {d.close < d.open && (
                  <span className="muted" style={{ fontSize: 11 }}>overnight (spans midnight)</span>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, display: 'grid', gap: 8 }}>
        <label style={{ marginBottom: 0 }}>
          Away message (sent when a customer writes outside hours)
          <textarea
            className="bn"
            value={form.awayMessage ?? ''}
            onChange={(e) => setForm({ ...form, awayMessage: e.target.value || null })}
            maxLength={500}
            rows={3}
            placeholder="Assalamu alaikum! Amra ekhon bondho achi. Shokal 9 tay khulbo — apnar message dekhe reply debo, InshaAllah."
          />
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          Sent <strong>at most once per customer per day</strong> — a second out-of-hours message hands the thread
          to a human instead of repeating the away text (P-09).
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>Save changes</Button>
        {dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
      </div>
    </div>
  )
}
