'use client'

/**
 * F4 — Settings shell (FRONTEND-SPEC §6.7 / architecture.md layout):
 * sub-nav tabs for channels / team / ai / business-hours / plan / audit,
 * with the same sliding-pill affordance as the main sidebar.
 */
import type { ReactNode } from 'react'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { m } from '@/lib/motion'

const TABS = [
  ['channels', 'Channels'],
  ['team', 'Team'],
  ['ai', 'AI assistant'],
  ['business-hours', 'Business hours'],
  ['plan', 'Plan & usage'],
  ['audit', 'Audit log'],
] as const

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const pathname = usePathname()

  return (
    <div style={{ maxWidth: 880 }}>
      <h1>Settings</h1>
      <nav
        aria-label="Settings sections"
        style={{
          display: 'flex', gap: 2, borderBottom: '1px solid var(--border)',
          marginBottom: 20, overflowX: 'auto', paddingBottom: 0,
        }}
      >
        {TABS.map(([seg, label]) => {
          const href = `/w/${workspaceId}/settings/${seg}`
          const active = pathname.startsWith(href)
          return (
            <Link
              key={seg}
              href={href}
              aria-current={active ? 'page' : undefined}
              style={{
                position: 'relative', padding: '8px 14px', fontSize: 13, whiteSpace: 'nowrap',
                fontWeight: active ? 650 : 480,
                color: active ? 'var(--brand-strong)' : 'var(--muted)',
                textDecoration: 'none', transition: 'color var(--dur-base) ease',
              }}
            >
              {label}
              {active && (
                <m.span
                  layoutId="settings-tab"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  style={{
                    position: 'absolute', left: 8, right: 8, bottom: -1, height: 2,
                    background: 'var(--brand)', borderRadius: 1,
                  }}
                />
              )}
            </Link>
          )
        })}
      </nav>
      {children}
    </div>
  )
}
