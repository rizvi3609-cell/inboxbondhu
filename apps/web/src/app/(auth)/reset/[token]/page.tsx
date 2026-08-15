'use client'

/**
 * F5 — reset/[token] (US-005): new-password form with the strength meter;
 * single-use token semantics surfaced; success → login. The API revokes all
 * sessions on reset — the copy says so.
 */
import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import { m, MotionRoot, cardEnter } from '@/lib/motion'
import { Button } from '@/components/ui/primitives'
import { StrengthMeter, assess } from '@/components/auth/StrengthMeter'

function ResetInner() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(false)
  const [busy, setBusy] = useState(false)

  const mismatch = confirm.length > 0 && confirm !== password

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!assess(password).ok || mismatch) {
      setShake(true)
      setTimeout(() => setShake(false), 300)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api('/api/v1/auth/reset-password', { method: 'POST', body: { token, password } })
      router.push('/login?reset=1')
    } catch (err) {
      setError(err instanceof ApiFailure
        ? err.error.message
        : 'Could not reach the server.')
      setShake(true)
      setTimeout(() => setShake(false), 300)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ maxWidth: 400, margin: '80px auto', padding: 16 }}>
      <m.div {...cardEnter} className={shake ? 'anim-shake' : undefined} style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-1)', padding: 24,
      }}>
        <h2 style={{ marginTop: 0 }}>Set a new password</h2>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Reset links are single-use. For safety, every signed-in device is signed out after the change.
        </p>
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label style={{ marginBottom: 0 }}>
            New password
            <input
              type="password" value={password} autoFocus
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password" required minLength={10} maxLength={128}
            />
            <StrengthMeter password={password} />
          </label>
          <label style={{ marginBottom: 0 }}>
            Confirm password
            <input
              type="password" value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password" required
              style={mismatch ? { borderColor: 'var(--danger)' } : undefined}
            />
            {mismatch && <span className="error-text">Passwords don&apos;t match.</span>}
          </label>
          {error && <p className="error-text" style={{ margin: 0 }}>{error}</p>}
          <Button variant="primary" type="submit" loading={busy} disabled={!assess(password).ok || mismatch}>
            Change password
          </Button>
          <p className="muted" style={{ margin: 0, textAlign: 'center', fontSize: 12 }}>
            Link expired? <Link href="/forgot">Request a new one</Link>
          </p>
        </form>
      </m.div>
    </main>
  )
}

export default function ResetPage() {
  return (
    <MotionRoot>
      <ResetInner />
    </MotionRoot>
  )
}
