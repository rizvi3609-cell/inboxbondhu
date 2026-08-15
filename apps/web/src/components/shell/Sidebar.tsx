'use client'

/**
 * App-shell sidebar (FRONTEND-SPEC §4.2): animated active indicator that
 * SLIDES between items (Motion shared layout), socket status dot with the
 * three §12.8 states, workspace switcher + sign-out at the bottom.
 * Mobile (<1024px): collapses to an icon rail.
 */
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { m } from '@/lib/motion'
import { api } from '@/lib/api-client'
import { useRealtime } from '@/lib/realtime-context'
import { ThemeToggle } from '@/components/ui/ThemeToggle'

const NAV = [
  ['inbox', '💬', 'Inbox'],
  ['orders', '📦', 'Orders'],
  ['catalogue', '🏷️', 'Catalogue'],
  ['knowledge', '📖', 'Knowledge'],
  ['analytics', '📊', 'Analytics'],
  ['settings', '⚙️', 'Settings'],
] as const

function StatusDot() {
  const { connState } = useRealtime()
  const color =
    connState === 'connected' ? 'var(--ok)'
    : connState === 'gave_up' ? 'var(--danger)'
    : 'var(--warn)'
  const label =
    connState === 'connected' ? 'Live updates connected'
    : connState === 'reconnecting' ? 'Reconnecting…'
    : connState === 'gave_up' ? 'Live updates paused'
    : 'Connecting…'
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block',
        animation:
          connState === 'connected' ? 'breathe-dot 2.4s ease-in-out infinite'
          : connState === 'reconnecting' || connState === 'connecting' ? 'blink 1s ease-in-out infinite'
          : 'none',
      }}
    />
  )
}

export function Sidebar({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname()
  const router = useRouter()

  async function logout() {
    await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => undefined)
    router.push('/login')
  }

  return (
    <aside
      style={{
        width: 'var(--sidebar-w, 216px)', flexShrink: 0,
        borderRight: '1px solid var(--border)', background: 'var(--panel)',
        padding: '16px 10px', display: 'flex', flexDirection: 'column', gap: 2,
        position: 'sticky', top: 0, height: '100vh',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', marginBottom: 14 }}>
        <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: '-0.02em', flex: 1 }} className="nav-label">
          Inbox<span style={{ color: 'var(--brand)' }}>Bondhu</span>
        </span>
        <StatusDot />
      </div>

      <nav aria-label="Main" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.map(([seg, icon, label]) => {
          const href = `/w/${workspaceId}/${seg}`
          const active = pathname.startsWith(href)
          return (
            <Link
              key={seg}
              href={href}
              prefetch={seg !== 'analytics'} // heavy aggregate route: on-demand (§5.2 item 11)
              aria-current={active ? 'page' : undefined}
              style={{
                position: 'relative', display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 'var(--radius-sm)',
                color: active ? 'var(--brand-strong)' : 'var(--text)',
                fontWeight: active ? 650 : 480, fontSize: 13, textDecoration: 'none',
                transition: 'color var(--dur-base) ease',
              }}
            >
              {active && (
                // The sliding pill — one shared layoutId, Motion FLIPs it
                // between nav items on route change (§4.2 page transitions).
                <m.span
                  layoutId="nav-active"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  style={{
                    position: 'absolute', inset: 0, background: 'var(--brand-soft)',
                    borderRadius: 'var(--radius-sm)', zIndex: 0,
                  }}
                />
              )}
              <span style={{ position: 'relative', zIndex: 1, fontSize: 15, width: 20, textAlign: 'center' }}>{icon}</span>
              <span className="nav-label" style={{ position: 'relative', zIndex: 1 }}>{label}</span>
            </Link>
          )
        })}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '0 4px' }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
          <Link href="/workspaces" className="muted nav-label" style={{ fontSize: 12, padding: '4px 6px' }}>
            ⇄ Switch workspace
          </Link>
          <ThemeToggle />
        </div>
        <button
          onClick={() => void logout()}
          style={{
            font: 'inherit', fontSize: 12, color: 'var(--muted)', background: 'none',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            padding: '6px 10px', cursor: 'pointer',
          }}
        >
          Sign out
        </button>
      </div>
    </aside>
  )
}
