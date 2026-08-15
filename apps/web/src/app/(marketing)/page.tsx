/**
 * F5 — Marketing landing (§6.9): RSC-only, zero client JS, CSS-only motion.
 * Hero in English + Bengali, a CSS mockup of the inbox, the feature triad,
 * CTA → register. Static-cacheable.
 */
import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

// cookies() makes this dynamic per-request (signed-in users skip the pitch);
// the page stays zero-client-JS either way.

const CSS = `
@keyframes land-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes land-pop { 0% { opacity: 0; transform: translateY(8px) scale(.97); } 100% { opacity: 1; transform: none; } }
.land-rise { animation: land-rise .5s cubic-bezier(.22,1,.36,1) both; }
.land-d1 { animation-delay: .08s; } .land-d2 { animation-delay: .16s; } .land-d3 { animation-delay: .24s; }
.land-bubble { animation: land-pop .45s cubic-bezier(.22,1,.36,1) both; }
.land-b1 { animation-delay: .5s; } .land-b2 { animation-delay: .9s; } .land-b3 { animation-delay: 1.35s; }
@media (prefers-reduced-motion: reduce) { .land-rise, .land-bubble { animation: none; } }
`

function Feature({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: 20, display: 'grid', gap: 6, alignContent: 'start',
    }}>
      <span style={{ fontSize: 26 }}>{icon}</span>
      <strong style={{ fontSize: 15 }}>{title}</strong>
      <span className="muted" style={{ fontSize: 13 }}>{body}</span>
    </div>
  )
}

export default async function LandingPage() {
  // Signed-in sellers land in their workspace, not on the pitch.
  const jar = await cookies()
  if (jar.has('ib_at') || jar.has('ib_rt')) redirect('/workspaces')
  return (
    <main>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <header style={{
        maxWidth: 960, margin: '0 auto', padding: '18px 20px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: '-0.02em' }}>
          Inbox<span style={{ color: 'var(--brand)' }}>Bondhu</span>
        </span>
        <nav style={{ marginLeft: 'auto', display: 'flex', gap: 18, alignItems: 'center', fontSize: 13 }}>
          <Link href="/pricing" style={{ color: 'var(--text)' }}>Pricing</Link>
          <Link href="/login" style={{ color: 'var(--text)' }}>Sign in</Link>
          <Link href="/register" style={{
            background: 'var(--brand)', color: '#fff', padding: '7px 16px',
            borderRadius: 'var(--radius-sm)', fontWeight: 650, textDecoration: 'none',
          }}>
            Start free
          </Link>
        </nav>
      </header>

      <section style={{ maxWidth: 960, margin: '0 auto', padding: '48px 20px 32px', textAlign: 'center' }}>
        <h1 className="land-rise" style={{ fontSize: 'clamp(28px, 5vw, 44px)', letterSpacing: '-0.03em', lineHeight: 1.15, margin: 0 }}>
          Your Facebook shop&apos;s inbox,<br />
          <span style={{ color: 'var(--brand-strong)' }}>answered in seconds — in Banglish.</span>
        </h1>
        <p className="land-rise land-d1 bn" style={{ fontSize: 16, color: 'var(--muted)', margin: '14px auto 0', maxWidth: 560 }}>
          রাত ৯টায় ৫০টা মেসেজ? InboxBondhu-র AI দাম, স্টক আর ডেলিভারি চার্জের উত্তর দেয় —
          অর্ডারের খুঁটিনাটিও নিজে জোগাড় করে।
        </p>
        <p className="land-rise land-d2 muted" style={{ margin: '10px auto 0', maxWidth: 560, fontSize: 14 }}>
          One inbox for Messenger &amp; Instagram. AI answers price, stock and delivery questions from
          <em> your</em> catalogue — never invented — and hands anything sensitive to a human.
        </p>
        <div className="land-rise land-d3" style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'center' }}>
          <Link href="/register" style={{
            background: 'var(--brand)', color: '#fff', padding: '11px 26px',
            borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: 15, textDecoration: 'none',
          }}>
            Start your 14-day trial
          </Link>
          <Link href="/pricing" style={{
            border: '1px solid var(--border-strong)', color: 'var(--text)', padding: '11px 26px',
            borderRadius: 'var(--radius-sm)', fontWeight: 600, fontSize: 15, textDecoration: 'none',
          }}>
            See pricing
          </Link>
        </div>
      </section>

      {/* CSS-only inbox mockup (§6.9) */}
      <section style={{ maxWidth: 620, margin: '0 auto', padding: '0 20px 48px' }}>
        <div style={{
          background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-2)', padding: 16, display: 'grid', gap: 10,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
            <span style={{ width: 28, height: 28, borderRadius: '50%', background: 'oklch(0.85 0.08 200)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700 }}>NJ</span>
            <strong style={{ fontSize: 13 }}>Nusrat</strong>
            <span style={{ background: 'var(--ai-soft)', color: 'var(--ai)', fontSize: 10, fontWeight: 700, borderRadius: 999, padding: '2px 8px' }}>🤖 AI</span>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>9:14 PM</span>
          </div>
          <div className="land-bubble land-b1 bn" style={{
            justifySelf: 'start', maxWidth: '75%', background: 'var(--panel-2)',
            borderRadius: '4px 14px 14px 14px', padding: '8px 12px', fontSize: 13,
          }}>
            ei blue saree ta dam koto? stock e ase?
          </div>
          <div className="land-bubble land-b2 bn" style={{
            justifySelf: 'end', maxWidth: '75%', background: 'var(--ai-soft)',
            borderRadius: '14px 4px 14px 14px', padding: '8px 12px', fontSize: 13,
          }}>
            Ei Blue Cotton Saree tar dam <strong>৳2,500</strong>. Ekhon stock e ase! Apni ki order korte chan? 😊
          </div>
          <div className="land-bubble land-b3" style={{ justifySelf: 'end', fontSize: 10.5, color: 'var(--muted)' }}>
            answered by AI in 4.2 seconds ✓✓
          </div>
        </div>
      </section>

      <section style={{ maxWidth: 960, margin: '0 auto', padding: '0 20px 56px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <Feature icon="🤖" title="AI that never invents prices"
          body="Answers come only from your catalogue and approved FAQs. No price, no answer — a human gets it instead." />
        <Feature icon="🛒" title="Orders captured in chat"
          body="Name, phone, address, size — collected conversationally. Stock is reserved the moment you confirm; overselling is impossible." />
        <Feature icon="📥" title="One inbox, whole team"
          body="Messenger and Instagram together. Take over from the AI with one click; roles keep viewers away from customer phone numbers." />
      </section>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '20px', textAlign: 'center', fontSize: 12 }} className="muted">
        InboxBondhu · made for Bangladeshi sellers · <Link href="/privacy">Privacy</Link>
      </footer>
    </main>
  )
}
