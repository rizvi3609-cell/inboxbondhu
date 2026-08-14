'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api-client'

export default function ForgotPage() {
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    // Always shows the same outcome — the API never leaks whether the email exists.
    await api('/api/v1/auth/forgot-password', { method: 'POST', body: { email } }).catch(() => undefined)
    setDone(true)
    setBusy(false)
  }

  return (
    <main style={{ maxWidth: 380, margin: '80px auto', padding: 16 }}>
      <h1 style={{ textAlign: 'center' }}>Reset password</h1>
      {done ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p>If an account exists for <strong>{email}</strong>, a reset link is on its way.</p>
          <Link href="/login">Back to sign in</Link>
        </div>
      ) : (
        <form className="card" onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <button className="primary" disabled={busy} type="submit">{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </main>
  )
}
