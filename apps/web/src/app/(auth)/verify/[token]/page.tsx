'use client'

/**
 * F5 — verify/[token] (US-002): auto-verifies on mount — spinner → animated
 * ✓ → redirect to login. Expired/invalid and already-verified states per the
 * acceptance criteria.
 */
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import { m, MotionRoot, cardEnter } from '@/lib/motion'
import { Button, CheckDraw, Spinner } from '@/components/ui/primitives'

type State = 'verifying' | 'done' | 'already' | 'invalid'

function VerifyInner() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()
  const [state, setState] = useState<State>('verifying')
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return // StrictMode double-mount guard: verify ONCE
    ran.current = true
    void api('/api/v1/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => {
        setState('done')
        setTimeout(() => router.push('/login'), 1_800)
      })
      .catch((err) => {
        if (err instanceof ApiFailure && /already/i.test(err.error.message)) setState('already')
        else setState('invalid')
      })
  }, [token, router])

  return (
    <main style={{ maxWidth: 400, margin: '90px auto', padding: 16 }}>
      <m.div {...cardEnter} style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-1)',
        padding: 28, textAlign: 'center', display: 'grid', gap: 12, justifyItems: 'center',
      }}>
        {state === 'verifying' && (
          <>
            <Spinner size={28} />
            <h2 style={{ margin: 0 }}>Verifying your email…</h2>
          </>
        )}
        {state === 'done' && (
          <>
            <CheckDraw size={40} />
            <h2 style={{ margin: 0 }}>Email verified!</h2>
            <p className="muted" style={{ margin: 0 }}>Taking you to sign in…</p>
          </>
        )}
        {state === 'already' && (
          <>
            <span style={{ fontSize: 36 }}>✅</span>
            <h2 style={{ margin: 0 }}>Already verified</h2>
            <Link href="/login"><Button variant="primary">Sign in</Button></Link>
          </>
        )}
        {state === 'invalid' && (
          <>
            <span style={{ fontSize: 36 }}>⛔</span>
            <h2 style={{ margin: 0 }}>Link expired or invalid</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Verification links are single-use and time-limited.
            </p>
            <Link href="/login"><Button variant="primary">Sign in to resend</Button></Link>
          </>
        )}
      </m.div>
    </main>
  )
}

export default function VerifyPage() {
  return (
    <MotionRoot>
      <VerifyInner />
    </MotionRoot>
  )
}
