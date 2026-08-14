'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'

function UnlockForm() {
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [otp, setOtp] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function requestOtp(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/v1/auth/unlock/request-otp', { method: 'POST', body: { email } })
      setSent(true)
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyOtp(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api('/api/v1/auth/unlock/verify-otp', { method: 'POST', body: { email, otp } })
      router.push('/login')
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ maxWidth: 380, margin: '80px auto', padding: 16 }}>
      <h1 style={{ textAlign: 'center' }}>Account locked</h1>
      <p className="muted" style={{ textAlign: 'center' }}>
        Too many failed sign-ins. Unlock with a one-time code.
      </p>
      <form className="card" onSubmit={sent ? verifyOtp : requestOtp} style={{ display: 'grid', gap: 12 }}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={sent} />
        </label>
        {sent && (
          <label>
            One-time code (from your email)
            <input value={otp} onChange={(e) => setOtp(e.target.value)} required inputMode="numeric" />
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <button className="primary" disabled={busy} type="submit">
          {busy ? 'Working…' : sent ? 'Unlock' : 'Send code'}
        </button>
      </form>
    </main>
  )
}

export default function UnlockPage() {
  return (
    <Suspense>
      <UnlockForm />
    </Suspense>
  )
}
