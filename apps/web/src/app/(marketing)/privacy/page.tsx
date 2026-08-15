/**
 * F5 — Privacy (§6.9). The statements here mirror what the backend actually
 * does (§15.2 retention, anonymisation, token encryption) — no marketing
 * fiction.
 */
import Link from 'next/link'

export const revalidate = 3600

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '32px 20px 64px' }}>
      <header style={{ marginBottom: 28 }}>
        <Link href="/" style={{ fontWeight: 800, fontSize: 17, color: 'var(--text)', textDecoration: 'none' }}>
          Inbox<span style={{ color: 'var(--brand)' }}>Bondhu</span>
        </Link>
      </header>
      <h1>Privacy</h1>
      <div style={{ display: 'grid', gap: 14, fontSize: 14, lineHeight: 1.65 }}>
        <p>
          InboxBondhu processes your customers&apos; messages so your team and your AI assistant can answer them.
          Here is what that means in practice — matching what the system actually does, not aspiration:
        </p>
        <p>
          <strong>Retention.</strong> Conversations, messages and orders are kept for 90 days, then deleted by an
          automated purge. Customer profiles are anonymised at 90 days of inactivity: name, phone and address are
          erased; an irreversible hash remains so repeat-customer counting still works without storing the number.
        </p>
        <p>
          <strong>Page tokens.</strong> Your Facebook Page access token is encrypted (AES-256-GCM) at rest, never
          logged, and never returned by any API. Disconnecting a Page destroys the stored token immediately.
        </p>
        <p>
          <strong>The AI.</strong> Customer messages are sent to a language-model provider to generate reply drafts.
          The AI can only state facts from your own catalogue and approved FAQs; its replies are checked before
          sending, and everything it says is recorded in your audit log.
        </p>
        <p>
          <strong>Your team.</strong> Role-based access controls who sees customer phone numbers and addresses.
          Every sensitive action — role changes, removals, order changes, discounts — is written to an audit trail
          you can query in Settings.
        </p>
        <p>
          <strong>Logs.</strong> Application logs redact passwords, tokens, phone numbers, addresses and message
          text by construction.
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          Questions? Write to privacy@inboxbondhu.me.
        </p>
      </div>
    </main>
  )
}
