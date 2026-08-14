'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'

interface Channel {
  id: string
  provider: 'facebook' | 'instagram'
  pageName: string
  status: string
  tokenExpiresAt?: string | null
}

interface PlanInfo {
  plan: string
  periodKey: string
  conversations: { used: number; limit: number }
  products: { used: number; limit: number }
  aiPaused: boolean
}

interface WorkspaceDoc {
  id: string
  name: string
  role: string
  version: number
  aiConfig?: {
    enabled: boolean
    autoReplyEnabled: boolean
    tone: 'friendly' | 'formal' | 'concise'
    maxDiscountPercent: number
  }
}

export default function SettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [channels, setChannels] = useState<Channel[]>([])
  const [plan, setPlan] = useState<PlanInfo | null>(null)
  const [ws, setWs] = useState<WorkspaceDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api<{ channels: Channel[] }>(`/api/v1/w/${workspaceId}/channels`),
      api<PlanInfo>(`/api/v1/w/${workspaceId}/plan`),
      api<WorkspaceDoc>(`/api/v1/w/${workspaceId}`),
    ])
    if (results[0].status === 'fulfilled') setChannels(results[0].value.channels)
    if (results[1].status === 'fulfilled') setPlan(results[1].value) // owner-only — 403 for others is fine
    if (results[2].status === 'fulfilled') setWs(results[2].value)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => setError('Some settings could not be loaded (role-limited).'))
  }, [load])

  async function connectPage() {
    setError(null)
    try {
      const { url } = await api<{ url: string }>(`/api/v1/w/${workspaceId}/channels/oauth/start`)
      window.location.href = url // Meta OAuth
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 502) {
        setError('Meta OAuth is not configured on this deployment yet (missing app credentials).')
      } else {
        setError(err instanceof ApiFailure ? err.error.message : 'Could not start the connect flow.')
      }
    }
  }

  async function disconnect(id: string) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/channels/${id}`, { method: 'DELETE' })
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Disconnect failed.')
    }
  }

  async function patchAi(patch: Record<string, unknown>) {
    if (!ws) return
    setError(null)
    setNotice(null)
    try {
      await api(`/api/v1/w/${workspaceId}/settings/ai`, { method: 'PATCH', body: patch, ifMatch: ws.version })
      setNotice('AI settings saved.')
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        setError('Settings changed elsewhere — reloaded the latest values.')
        await load()
      } else {
        setError(err instanceof ApiFailure ? err.error.message : 'Save failed.')
      }
    }
  }

  async function changePlan(newPlan: string) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/plan/change`, { method: 'POST', body: { plan: newPlan } })
      setNotice(`Plan changed to ${newPlan}.`)
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Plan change failed.')
    }
  }

  const ai = ws?.aiConfig

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 760 }}>
      <h1 style={{ margin: 0 }}>Settings</h1>
      {error && <p className="error-text">{error}</p>}
      {notice && <p style={{ color: 'var(--ok)' }}>{notice}</p>}

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Channels</h3>
        {channels.length === 0 ? (
          <p className="muted">No Facebook Page or Instagram account connected.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
            {channels.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <strong>{c.pageName}</strong>
                <span className="badge active">{c.provider}</span>
                <span className={`badge ${c.status === 'active' ? 'approved' : 'draft'}`}>{c.status}</span>
                <button style={{ marginLeft: 'auto' }} onClick={() => void disconnect(c.id)}>Disconnect</button>
              </div>
            ))}
          </div>
        )}
        <button className="primary" onClick={() => void connectPage()}>Connect a Facebook Page</button>
      </section>

      {ai && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>AI assistant</h3>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={ai.autoReplyEnabled}
                onChange={(e) => void patchAi({ autoReplyEnabled: e.target.checked })} />
              Auto-reply to customers (off = AI drafts nothing; agents handle everything)
            </label>
            <label>
              Tone
              <select value={ai.tone} onChange={(e) => void patchAi({ tone: e.target.value })}>
                <option value="friendly">Friendly</option>
                <option value="formal">Formal</option>
                <option value="concise">Concise</option>
              </select>
            </label>
            <label>
              Max discount the AI may offer (%)
              <input type="number" min={0} max={50} defaultValue={ai.maxDiscountPercent}
                onBlur={(e) => {
                  const v = Number(e.target.value)
                  if (v !== ai.maxDiscountPercent) void patchAi({ maxDiscountPercent: v })
                }} />
            </label>
          </div>
        </section>
      )}

      {plan && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Plan & usage <span className="muted">({plan.periodKey})</span></h3>
          <p>
            Current plan: <strong>{plan.plan}</strong>
            {plan.aiPaused && <span className="badge pending" style={{ marginLeft: 8 }}>AI paused — quota reached (humans unaffected)</span>}
          </p>
          <p className="muted">
            Conversations: {plan.conversations.used} / {plan.conversations.limit} · Products: {plan.products.used} / {plan.products.limit}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            {['starter', 'growth'].filter((p) => p !== plan.plan).map((p) => (
              <button key={p} className="primary" onClick={() => void changePlan(p)}>Switch to {p}</button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
