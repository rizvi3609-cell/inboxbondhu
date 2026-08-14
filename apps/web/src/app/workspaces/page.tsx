'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import type { WorkspaceSummary } from '@/lib/types'

export default function WorkspacesPage() {
  const router = useRouter()
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // The list endpoint returns the memberships shape: [{workspaceId, name, slug, role}].
    api<Array<{ workspaceId: string; name: string; slug: string; role: WorkspaceSummary['role']; plan?: WorkspaceSummary['plan'] }>>('/api/v1/workspaces')
      .then((list) => {
        const mapped = list.map((w) => ({ id: w.workspaceId, name: w.name, slug: w.slug, role: w.role, plan: w.plan ?? 'trial' }))
        setWorkspaces(mapped)
        if (mapped.length === 1) router.replace(`/w/${mapped[0]!.id}/inbox`)
      })
      .catch((err) => setError(err instanceof ApiFailure ? err.error.message : 'Could not load workspaces.'))
  }, [router])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const created = await api<{ workspaceId: string }>('/api/v1/workspaces', { method: 'POST', body: { name } })
      router.push(`/w/${created.workspaceId}/inbox`)
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Could not create the workspace.')
      setBusy(false)
    }
  }

  return (
    <main style={{ maxWidth: 520, margin: '60px auto', padding: 16 }}>
      <h1>Your workspaces</h1>
      {error && <p className="error-text">{error}</p>}
      {workspaces === null ? (
        <p className="muted">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="muted">No workspace yet — create your shop below.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
          {workspaces.map((w) => (
            <button key={w.id} className="card" style={{ textAlign: 'left' }} onClick={() => router.push(`/w/${w.id}/inbox`)}>
              <strong>{w.name}</strong>{' '}
              <span className="badge active">{w.role}</span>{' '}
              <span className="muted">· {w.plan}</span>
            </button>
          ))}
        </div>
      )}
      <form className="card" onSubmit={create} style={{ display: 'grid', gap: 12 }}>
        <h3 style={{ margin: 0 }}>New workspace</h3>
        <label>
          Shop name
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
        </label>
        <button className="primary" disabled={busy} type="submit">{busy ? 'Creating…' : 'Create workspace'}</button>
      </form>
    </main>
  )
}
