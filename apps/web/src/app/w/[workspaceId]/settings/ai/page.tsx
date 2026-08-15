'use client'

/**
 * F4 — Settings → AI assistant (§6.7): toggles + tone + discount-cap slider
 * (0–50) + handover-keywords chip input. Explicit Save with If-Match; 409 →
 * the C-6 ConflictDialog with per-field diff.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { WorkspaceView } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { Badge, Button, Skeleton } from '@/components/ui/primitives'
import { ConflictDialog, useToast, type ConflictInfo } from '@/components/ui/overlay'

type AiConfig = WorkspaceView['aiConfig']

const FIELDS: Array<keyof AiConfig> = ['enabled', 'autoReplyEnabled', 'tone', 'maxDiscountPercent', 'handoverKeywords']

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 0 }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        style={{
          width: 40, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
          background: checked ? 'var(--brand)' : 'var(--border-strong)',
          position: 'relative', flexShrink: 0, transition: 'background-color var(--dur-base) ease', padding: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 20 : 2, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', boxShadow: 'var(--shadow-1)',
          transition: 'left var(--dur-base) var(--ease-out-soft)',
        }} />
      </button>
      <span>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        <span className="muted" style={{ display: 'block', fontSize: 12 }}>{hint}</span>
      </span>
    </label>
  )
}

export default function AiSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [ws, setWs] = useState<WorkspaceView | null>(null)
  const [form, setForm] = useState<AiConfig | null>(null)
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)

  const load = useCallback(async () => {
    const data = await api<WorkspaceView>(`/api/v1/w/${workspaceId}`)
    setWs(data)
    setForm({ ...data.aiConfig })
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  const dirty = ws && form && FIELDS.some((f) => JSON.stringify(form[f]) !== JSON.stringify(ws.aiConfig[f]))

  async function save() {
    if (!ws || !form) return
    setBusy(true)
    // Send only the changed fields — smaller diffs, cleaner audit rows.
    const patch: Record<string, unknown> = {}
    for (const f of FIELDS) {
      if (JSON.stringify(form[f]) !== JSON.stringify(ws.aiConfig[f])) patch[f] = form[f]
    }
    try {
      await api(`/api/v1/w/${workspaceId}/settings/ai`, { method: 'PATCH', body: patch, ifMatch: ws.version })
      toast('success', 'AI settings saved.')
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        const fresh = await api<WorkspaceView>(`/api/v1/w/${workspaceId}`)
        const fields = Object.keys(patch)
        setConflict({
          conflictingFields: fields,
          mine: Object.fromEntries(fields.map((f) => [f, patch[f]])),
          theirs: Object.fromEntries(fields.map((f) => [f, fresh.aiConfig[f.replace('aiConfig.', '') as keyof AiConfig]])),
        })
        setWs(fresh) // reapply will PATCH against the fresh version
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Save failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  function addKeyword() {
    const k = keyword.trim().toLowerCase()
    if (!k || !form) return
    if (form.handoverKeywords.includes(k)) {
      setKeyword('')
      return
    }
    setForm({ ...form, handoverKeywords: [...form.handoverKeywords, k] })
    setKeyword('')
  }

  if (!form || !ws) {
    return <div style={{ display: 'grid', gap: 12 }}><Skeleton height={60} radius={12} /><Skeleton height={120} radius={12} /></div>
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, display: 'grid', gap: 14 }}>
        <Toggle
          checked={form.enabled}
          onChange={(v) => setForm({ ...form, enabled: v })}
          label="AI assistant"
          hint="Master switch. Off = the AI never runs on any conversation."
        />
        <Toggle
          checked={form.autoReplyEnabled}
          onChange={(v) => setForm({ ...form, autoReplyEnabled: v })}
          label="Auto-reply to customers"
          hint="Off = the AI drafts nothing; every message waits for a human."
        />
        <label>
          Tone
          <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value as AiConfig['tone'] })} style={{ maxWidth: 220 }}>
            <option value="friendly">Friendly (bhaiya/apu warmth)</option>
            <option value="formal">Formal</option>
            <option value="concise">Concise</option>
          </select>
        </label>
      </div>

      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, display: 'grid', gap: 8 }}>
        <label style={{ marginBottom: 0 }}>
          Maximum discount the AI may offer
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <input
              type="range" min={0} max={50} step={1}
              value={form.maxDiscountPercent}
              onChange={(e) => setForm({ ...form, maxDiscountPercent: Number(e.target.value) })}
              style={{ flex: 1, padding: 0, accentColor: 'var(--brand)' }}
            />
            <span className="mono-num" style={{ fontWeight: 800, fontSize: 16, width: 48, textAlign: 'right', color: form.maxDiscountPercent > 20 ? 'var(--warn)' : 'var(--text)' }}>
              {form.maxDiscountPercent}%
            </span>
          </div>
        </label>
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          Hard-enforced by the grounding gate: the AI can never promise more than this, and 50% is the platform ceiling.
        </p>
      </div>

      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, display: 'grid', gap: 8 }}>
        <label style={{ marginBottom: 0 }}>Handover keywords — any of these in a customer message hands the thread to a human</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {form.handoverKeywords.map((k) => (
            <Badge key={k} tone="warn">
              <span className="bn">{k}</span>
              <button
                onClick={() => setForm({ ...form, handoverKeywords: form.handoverKeywords.filter((x) => x !== k) })}
                aria-label={`Remove ${k}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', padding: 0, font: 'inherit', marginLeft: 2 }}
              >
                ✕
              </button>
            </Badge>
          ))}
          {form.handoverKeywords.length === 0 && <span className="muted" style={{ fontSize: 12 }}>None yet — e.g. “complaint”, “refund”, “মালিক”.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="bn" value={keyword} maxLength={60}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addKeyword()
              }
            }}
            placeholder="Add a keyword and press Enter"
            style={{ maxWidth: 280 }}
          />
          <Button small onClick={addKeyword} disabled={!keyword.trim()}>Add</Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
          Save changes
        </Button>
        {dirty && <span className="muted" style={{ fontSize: 12 }}>Unsaved changes</span>}
      </div>

      <ConflictDialog
        open={conflict !== null}
        info={conflict}
        onReapply={() => {
          setConflict(null)
          void save() // ws was refreshed → PATCH now carries the fresh If-Match
        }}
        onKeepTheirs={() => {
          setConflict(null)
          void load()
        }}
      />
    </div>
  )
}
