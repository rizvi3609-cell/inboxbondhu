'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import type { KnowledgeItemView } from '@inboxbondhu/contracts'

export default function KnowledgePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [rows, setRows] = useState<KnowledgeItemView[]>([])
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await api<{ items: KnowledgeItemView[] }>(`/api/v1/w/${workspaceId}/knowledge`)
    setRows(data.items)
  }, [workspaceId])

  useEffect(() => {
    void load().catch((err) => setError(err instanceof ApiFailure ? err.error.message : 'Load failed.'))
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge`, { method: 'POST', body: { question, answer } })
      setQuestion('')
      setAnswer('')
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Create failed.')
    } finally {
      setBusy(false)
    }
  }

  async function approve(item: KnowledgeItemView) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge/${item.id}/approve`, { method: 'POST', ifMatch: item.version })
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Approve failed.')
    }
  }

  async function remove(item: KnowledgeItemView) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge/${item.id}`, { method: 'DELETE', ifMatch: item.version })
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Archive failed.')
    }
  }

  return (
    <div>
      <h1>Knowledge base</h1>
      <p className="muted">
        The AI answers ONLY from approved FAQs and the catalogue — a draft is invisible to it. Approving is a deliberate act.
      </p>
      {error && <p className="error-text">{error}</p>}
      <form className="card" onSubmit={create} style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
        <label>
          Question (e.g. “Delivery charge koto?”)
          <input value={question} onChange={(e) => setQuestion(e.target.value)} required minLength={5} maxLength={500} />
        </label>
        <label>
          Answer (this is exactly what the AI may say)
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} required minLength={5} maxLength={2000} rows={3} />
        </label>
        <div><button className="primary" disabled={busy} type="submit">Add as draft</button></div>
      </form>
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((k) => (
          <div key={k.id} className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <strong>{k.question}</strong> <span className={`badge ${k.status}`}>{k.status}</span>
              <p style={{ margin: '6px 0 0' }} className="muted">{k.answer}</p>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {k.status === 'draft' && <button className="primary" onClick={() => void approve(k)}>Approve</button>}
              {k.status !== 'archived' && <button onClick={() => void remove(k)}>Archive</button>}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div className="card muted">No FAQs yet.</div>}
      </div>
    </div>
  )
}
