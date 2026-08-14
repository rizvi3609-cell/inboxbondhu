'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api, ApiFailure } from '@/lib/api-client'

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/v1/auth/login', { method: 'POST', body: { email, password } })
      router.push(params.get('next') ?? '/workspaces')
    } catch (err) {
      if (err instanceof ApiFailure) {
        if (err.error.code === 'ACCOUNT_LOCKED') {
          router.push(`/unlock?email=${encodeURIComponent(email)}`)
          return
        }
        setError(err.error.message)
      } else {
        setError('Could not reach the server.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ maxWidth: 380, margin: '80px auto', padding: 16 }}>
      <h1 style={{ textAlign: 'center' }}>InboxBondhu</h1>
      <p className="muted" style={{ textAlign: 'center' }}>Sign in to your seller dashboard</p>
      <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy} type="submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted" style={{ margin: 0, display: 'flex', justifyContent: 'space-between' }}>
          <Link href="/forgot">Forgot password?</Link>
          <Link href="/register">Create account</Link>
        </p>
      </form>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
