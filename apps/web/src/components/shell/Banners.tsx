'use client'

/**
 * The three global banners (FRONTEND-SPEC §6.7/§4.2, sources C-10, prd §2.11,
 * user-story Act 9). Stacked below the top of <main>; each slides down via
 * height auto-animation and slides away on recovery.
 */
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AnimatePresence, m } from '@/lib/motion'
import { Button } from '@/components/ui/primitives'
import { useRealtime } from '@/lib/realtime-context'

function Banner({ tone, children }: { tone: 'danger' | 'warn' | 'info'; children: ReactNode }) {
  const bg = tone === 'danger' ? 'var(--danger-soft)' : tone === 'warn' ? 'var(--warn-soft)' : 'var(--brand-soft)'
  const border = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--brand)'
  return (
    <m.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      style={{ overflow: 'hidden' }}
    >
      <div
        role="status"
        style={{
          background: bg, borderBottom: `2px solid ${border}`,
          padding: '9px 16px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10,
        }}
      >
        {children}
      </div>
    </m.div>
  )
}

/** §14.1: /healthz polled — degraded:true ⇒ the global banner (C-10). */
export function DegradedBanner() {
  const [degraded, setDegraded] = useState(false)
  useEffect(() => {
    let alive = true
    const poll = () => {
      void fetch('/healthz')
        .then((r) => r.json())
        .then((j: { data?: { degraded?: boolean } }) => {
          if (alive) setDegraded(Boolean(j.data?.degraded))
        })
        .catch(() => {
          if (alive) setDegraded(true)
        })
    }
    poll()
    const t = setInterval(poll, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return (
    <AnimatePresence>
      {degraded && (
        <Banner tone="danger">
          <span style={{ fontWeight: 650 }}>⚠ Degraded mode</span>
          <span>
            The database is unreachable. Incoming customer messages are still being received and buffered;
            the dashboard is read-limited until recovery.
          </span>
        </Banner>
      )}
    </AnimatePresence>
  )
}

/** prd §2.11: 80% warn / 100% AI-paused — live via the quota.warning socket. */
export function QuotaBanner({ workspaceId }: { workspaceId: string }) {
  const { subscribe } = useRealtime()
  const [level, setLevel] = useState<0 | 80 | 100>(0)
  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event === 'quota.warning') setLevel((payload as { level: 80 | 100 }).level)
      }),
    [subscribe],
  )
  return (
    <AnimatePresence>
      {level > 0 && (
        <Banner tone={level === 100 ? 'danger' : 'warn'}>
          <span style={{ fontWeight: 650 }}>{level === 100 ? '🔴 Quota reached' : '🟠 80% of quota used'}</span>
          <span>
            {level === 100
              ? 'The AI assistant is paused — human replies keep working.'
              : 'Approaching this month\u2019s conversation limit.'}
          </span>
          <Link href={`/w/${workspaceId}/settings`} style={{ marginLeft: 'auto', fontWeight: 600 }}>
            View plan →
          </Link>
        </Banner>
      )}
    </AnimatePresence>
  )
}

/** user-story Act 9: expiring/expired channel token → Reconnect banner.
 *  Fetches once per shell mount (admins get data; 403 for agents/viewers is
 *  silent — the banner is a nudge, channels/page.tsx is the real surface). */
export function ChannelExpiryBanner({ workspaceId }: { workspaceId: string }) {
  const [expiringPageName, setExpiring] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void import('@/lib/api-client').then(({ api }) =>
      api<Array<{ pageName: string; status: string }>>(`/api/v1/w/${workspaceId}/channels`)
        .then((channels) => {
          if (!alive) return
          const bad = channels.find((c) => c.status === 'expired' || c.status === 'expiring')
          setExpiring(bad?.pageName ?? null)
        })
        .catch(() => undefined), // non-admins: banner stays silent
    )
    return () => {
      alive = false
    }
  }, [workspaceId])
  return (
    <AnimatePresence>
      {expiringPageName && (
        <Banner tone="warn">
          <span style={{ fontWeight: 650 }}>⚠ Facebook connection expiring</span>
          <span>
            Your Page <strong>{expiringPageName}</strong> needs reconnecting — messages stop flowing when the token dies.
          </span>
          <Link href={`/w/${workspaceId}/settings/channels`} style={{ marginLeft: 'auto' }}>
            <Button small variant="primary">Reconnect Facebook Page</Button>
          </Link>
        </Banner>
      )}
    </AnimatePresence>
  )
}

/** §12.8: gave_up after 20 attempts → manual Reconnect (C-8). */
export function SocketGaveUpBanner() {
  const { connState, retryNow } = useRealtime()
  return (
    <AnimatePresence>
      {connState === 'gave_up' && (
        <Banner tone="warn">
          <span style={{ fontWeight: 650 }}>Live updates paused</span>
          <span>Could not reach the realtime server after several attempts.</span>
          <span style={{ marginLeft: 'auto' }}>
            <Button small variant="primary" onClick={retryNow}>Reconnect</Button>
          </span>
        </Banner>
      )}
    </AnimatePresence>
  )
}
