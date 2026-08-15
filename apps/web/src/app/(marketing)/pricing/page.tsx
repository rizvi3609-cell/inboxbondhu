/**
 * F5 — Pricing (§6.9): the three tiers straight from contracts' PLAN_LIMITS
 * (the F4.1 single source — marketing can't drift from enforcement either).
 * RSC-only, static.
 */
import Link from 'next/link'
import { PLAN_LIMITS } from '@inboxbondhu/contracts/views'

export const revalidate = 3600

const TIERS = [
  { id: 'trial', name: 'Trial', price: 'Free', period: '14 days', highlight: false, blurb: 'Prove it on your Page' },
  { id: 'starter', name: 'Starter', price: '৳1,500', period: '/month', highlight: true, blurb: 'For one busy Page' },
  { id: 'growth', name: 'Growth', price: '৳4,000', period: '/month', highlight: false, blurb: 'For multi-Page sellers' },
] as const

export default function PricingPage() {
  return (
    <main style={{ maxWidth: 920, margin: '0 auto', padding: '32px 20px 64px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 40 }}>
        <Link href="/" style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.02em', color: 'var(--text)', textDecoration: 'none' }}>
          Inbox<span style={{ color: 'var(--brand)' }}>Bondhu</span>
        </Link>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 18, fontSize: 13 }}>
          <Link href="/login" style={{ color: 'var(--text)' }}>Sign in</Link>
        </nav>
      </header>

      <h1 style={{ textAlign: 'center', fontSize: 'clamp(24px, 4vw, 34px)' }}>Simple pricing, in taka.</h1>
      <p className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
        Every plan includes the AI assistant, order capture, and the full team inbox.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 32 }}>
        {TIERS.map((t) => {
          const limits = PLAN_LIMITS[t.id]
          return (
            <div key={t.id} style={{
              background: 'var(--panel)', borderRadius: 'var(--radius-lg)', padding: 24,
              border: `2px solid ${t.highlight ? 'var(--brand)' : 'var(--border)'}`,
              boxShadow: t.highlight ? 'var(--shadow-2)' : 'var(--shadow-1)',
              display: 'grid', gap: 10, alignContent: 'start', position: 'relative',
            }}>
              {t.highlight && (
                <span style={{
                  position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)',
                  background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700,
                  borderRadius: 999, padding: '2px 12px',
                }}>
                  Most popular
                </span>
              )}
              <strong style={{ fontSize: 16 }}>{t.name}</strong>
              <div>
                <span style={{ fontSize: 30, fontWeight: 800 }}>{t.price}</span>
                <span className="muted" style={{ fontSize: 13 }}> {t.period}</span>
              </div>
              <span className="muted" style={{ fontSize: 13 }}>{t.blurb}</span>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, display: 'grid', gap: 5 }}>
                <li><strong>{limits?.conversations.toLocaleString()}</strong> conversations / month</li>
                <li><strong>{limits?.products.toLocaleString()}</strong> products</li>
                <li>AI Banglish replies with the no-invention guarantee</li>
                <li>In-chat order capture with stock reservation</li>
                <li>Messenger + Instagram in one inbox</li>
              </ul>
              <Link href="/register" style={{
                marginTop: 8, textAlign: 'center', padding: '9px 0', borderRadius: 'var(--radius-sm)',
                fontWeight: 650, fontSize: 14, textDecoration: 'none',
                background: t.highlight ? 'var(--brand)' : 'transparent',
                color: t.highlight ? '#fff' : 'var(--brand-strong)',
                border: t.highlight ? 'none' : '1px solid var(--brand)',
              }}>
                {t.id === 'trial' ? 'Start free' : 'Start with trial'}
              </Link>
            </div>
          )
        })}
      </div>

      <p className="muted" style={{ textAlign: 'center', marginTop: 24, fontSize: 12 }}>
        At 100% of quota the AI pauses but your team keeps replying — you never lose a customer to a hard cutoff.
        Upgrades apply instantly.
      </p>
    </main>
  )
}
