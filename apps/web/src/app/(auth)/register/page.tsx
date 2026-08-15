'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { api, ApiFailure } from '@/lib/api-client'
import { StrengthMeter } from '@/components/auth/StrengthMeter'

export default function RegisterPage() {
  const [name, setName] = useState('')
  const [storeName, setStoreName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // T4: registration bootstraps the workspace from storeName.
      await api('/api/v1/auth/register', { method: 'POST', body: { name, storeName, email, password } })
      setDone(true) // 201, NO session — email verification first (T4)
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <main style={{ maxWidth: 420, margin: '80px auto', padding: 16 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <h2>Check your email</h2>
          <p className="muted">
            We sent a verification link to <strong>{email}</strong>. Verify it, then{' '}
            <Link href="/login">sign in</Link>.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main style={{ maxWidth: 380, margin: '80px auto', padding: 16 }}>
      <h1 style={{ textAlign: 'center' }}>Create your account</h1>
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />
        </label>
        <label>
          Shop name (your workspace)
          <input value={storeName} onChange={(e) => setStoreName(e.target.value)} required minLength={1} maxLength={100} placeholder="Rupa Fashion" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} maxLength={128} autoComplete="new-password" />
          <StrengthMeter password={password} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy} type="submit">{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </form>
    </main>
  )
}
