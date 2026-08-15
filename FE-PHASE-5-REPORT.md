# FE Phase 5 — Analytics + Auth polish + Marketing: report

**Status: done.** Typecheck clean, lint clean, **355/355 tests green**, bundle budget green — **25 routes**, all ≤ 170 kB. Marketing pages are RSC-only at **176 B route JS**. All six new/rebuilt routes smoke-tested live (200s, content verified).

## What was built

### Analytics (`analytics/page.tsx`) — §6.6 / user-story Act 11
- **Conversion-rate hero** — the PRD §1.5 primary metric gets the biggest card, brand-bordered, with the honest caption ("confirmed orders ÷ conversations — the number that pays the bills").
- **Number tickers (§4.2):** count up once on first view via rAF ease-out-cubic — no library; instant under `prefers-reduced-motion` (Motion's `useReducedMotion`).
- **The Act 11 morning-chai cards:** conversations (+% AI-handled), AI replies (+avg first-response seconds), grounding-blocked ("answers the AI refused to invent" — the guarantee made visible), AI cost in ৳, revenue + confirmed/total.
- **Pure-SVG bar chart (§3.4 — no chart lib):** Dhaka-day buckets, staggered growth animation (capped 400 ms total), hover tooltip, metric tabs (conversations/orders/AI replies), keyboard-safe.
- **Range picker** 7/30/90 d via the F0 Tabs.
- **Handover attention card** (Act 11's "⚠ N handovers pending") deep-links to the inbox.

### Auth polish (§6.8, US-002/US-005)
- **`verify/[token]`** — auto-verifies on mount (StrictMode double-mount guarded so the single-use token isn't burned twice by React): spinner → **✓ draw-in** → auto-redirect; distinct *already-verified* and *expired/invalid* states per US-002.
- **`reset/[token]`** — new-password form with confirm-match validation, single-use + all-sessions-revoked copy (matches the backend's actual behaviour), shake on invalid submit, success → `/login?reset=1`.
- **StrengthMeter** — 4-segment bar animating red→amber→green→brand. Deliberately mirrors contracts' `passwordPolicy` (≥10, upper, lower, digit) instead of shipping zxcvbn (~380 kB — the PRD mentions it; the budget vetoes it; flagged below). Wired into **register** too, which also fixes register's stale `minLength={8}` → 10.

### Marketing (`(marketing)/` — §6.9)
- **Landing:** hero in English + Bengali (Noto Bengali font path), **CSS-only animated inbox mockup** (Nusrat asks "dam koto?", AI answers with ৳2,500 in 4.2 s — the user-story's own scene), feature triad (no-invention AI / in-chat orders / one inbox), CTAs. **Zero client JS** — animations are pure CSS keyframes with a reduced-motion kill switch.
- **Pricing:** the three tiers with limits **imported from contracts' `PLAN_LIMITS`** — the F4.1 single source now reaches marketing, so the pricing page can't drift from enforcement either. Honest quota copy ("AI pauses, your team keeps replying").
- **Privacy:** every claim mirrors real backend behaviour (90-day purge, anonymisation with surviving hash, AES-256-GCM tokens, audit trail, log redaction) — no marketing fiction.
- **Route-conflict fix:** the old `app/page.tsx` (redirect-only) and `(marketing)/page.tsx` both resolved to `/`. Old file deleted; its signed-in redirect moved into the landing page (cookies() → `/workspaces`). `/pricing` + `/privacy` added to middleware PUBLIC_PATHS.

## Live smoke (production build)
```
/ /pricing /privacy /verify/[t] /reset/[t] /register → all 200
landing renders hero + CTA; pricing renders 1,000/5,000 FROM PLAN_LIMITS
marketing route JS: 176 B (RSC-only achieved)
```

## Deviations / flags
1. **zxcvbn NOT shipped** — prd §2.1 names "zxcvbn score ≥ 3" for registration. The server enforces its own passwordPolicy (contracts), and shipping zxcvbn costs ~380 kB against a 25 kB/route budget. The meter mirrors the *enforced* policy instead. If real zxcvbn scoring is wanted, `zxcvbn-ts` core (~35 kB) lazy-loaded on the auth routes is the path — decision flagged, not silently made.
2. **Trial pricing strings ("৳1,500", "৳4,000") are marketing copy** on the pricing page only — no billing system exists yet (payment capture is P1 post-MVP per the spec). Limits come from contracts; prices are display-only until billing lands.
3. `verify` treats any non-"already" failure as expired/invalid — the API deliberately doesn't distinguish (no token-status oracle), so the UI offers the resend path either way.
4. Landing `cookies()` makes `/` dynamic (not statically cached) — deliberate trade: signed-in sellers skip the pitch (Act 11 daily flow), and the page is still zero-JS + fast. `/pricing` + `/privacy` keep `revalidate: 3600`.

## How to verify
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:web   # 25 routes
# live: / (animated mockup) · /pricing (contracts numbers) · register (meter)
# · analytics (tickers + bars once logged in)
```
