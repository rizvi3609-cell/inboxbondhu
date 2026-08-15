# InboxBondhu — Frontend Specification (v1.0)

> **The single authoritative frontend document.** Compiled from every frontend
> instruction scattered across `architecture.md` (ADR-001, §repo-layout, §12.8,
> §16.5, §17.1), `prd.md` (§2, §4.2, §4.6), `user-story.md` (all Acts + US
> acceptance criteria), and `prompt.md` (§9 Phase 9) — plus the product
> requirement added on top: **super optimized, beautiful, modern, animated**.
>
> Where this document and the source specs conflict, the source specs win on
> *behaviour*; this document wins on *visual design and motion*, which the
> source specs never defined.

---

## 0. The one-line brief

A Bangladeshi fashion seller opens this dashboard on a mid-range Android phone
over a 4G connection at 9 PM peak hours, and it must feel **instant, alive,
and premium** — first paint < 2 s, every realtime update visibly animated,
zero jank at 60 fps.

---

## 1. Hard constraints (from the source specs — non-negotiable)

| # | Constraint | Source |
|---|---|---|
| C-1 | Next.js 15 App Router + React 19 + TypeScript, SSR/RSC for first paint | architecture.md ADR-001 |
| C-2 | Dashboard perceived load **< 2 s**; skeleton state if any list > 2 s | prd.md §4.2 "Progressive rendering" |
| C-3 | Socket delivery reflected in UI **< 1 s** (CON-03) | architecture.md §constraints |
| C-4 | HttpOnly cookie sessions; CSRF mirror header on every mutation; the access token NEVER in JS-readable storage | architecture.md §auth |
| C-5 | Nonce-based CSP (`'nonce-{r}' 'strict-dynamic'`) via middleware — no inline scripts without the nonce, `style-src 'unsafe-inline'` allowed | architecture.md §17.1 / ADR-012 |
| C-6 | OCC: every versioned PATCH sends `If-Match`; **409 → refetch, show a diff, ask the user to reapply — never silent retry** | architecture.md §OCC, dfd.md F-622 |
| C-7 | Replies/orders send `Idempotency-Key` (crypto.randomUUID) | prompt.md §7.3 #44/#60 |
| C-8 | Socket reconnect: exponential backoff + full jitter `min(30s, 500ms·2^n)·random()`, **20-attempt cap → manual "Reconnect" button**; on reconnect send `updatedSince` and merge the **delta**, never full refetch | architecture.md §12.8 |
| C-9 | Client-side RBAC is UI-only sugar (`lib/permissions.ts`) — never trusted, never a security boundary | architecture.md repo layout |
| C-10 | Degraded mode → **global banner**; reads keep working, writes explain themselves | architecture.md §12.2 health surface |
| C-11 | Web imports types from `@inboxbondhu/contracts` — an API break must fail the web **build** | architecture.md §packages/contracts (currently unmet — audit L-3) |
| C-12 | All money displayed from `*Minor` integers; ৳ prefix; never a float | agent.md / kernel Money |
| C-13 | All timestamps rendered in **Asia/Dhaka** | prompt.md §business rules |
| C-14 | Media failure state: "Image unavailable — view in Messenger" + deep link | architecture.md §12.7 |
| C-15 | RSC cache: `revalidate` 0 for inbox/orders, 60 s for analytics | architecture.md §16 cache table |

---

## 2. Route map (authoritative — from architecture.md repo layout)

```
src/app/
├─ (marketing)/                       # public, static, zero JS where possible
│  ├─ page.tsx                        # landing — hero, features, CTA
│  ├─ pricing/page.tsx                # trial/starter/growth table
│  └─ privacy/page.tsx
├─ (auth)/                            # centered card layout, animated
│  ├─ login/page.tsx
│  ├─ register/page.tsx               # T4: name + storeName + email + password
│  ├─ verify/[token]/page.tsx         # auto-verifies on mount → success state
│  ├─ reset/[token]/page.tsx          # new-password form
│  ├─ forgot/page.tsx
│  └─ unlock/page.tsx                 # OTP ladder (US-004)
├─ w/[workspaceId]/                   # app shell: sidebar + socket provider
│  ├─ layout.tsx                      # tenant guard, realtime provider, banners
│  ├─ page.tsx                        # → redirect to ./inbox
│  ├─ inbox/
│  │  ├─ page.tsx                     # split-pane list (Act 6 ASCII layout)
│  │  └─ [conversationId]/page.tsx    # thread (mobile: own screen)
│  ├─ orders/page.tsx
│  ├─ catalogue/page.tsx
│  ├─ knowledge/page.tsx
│  ├─ analytics/page.tsx              # Fatima's "morning chai" overview (Act 11)
│  └─ settings/
│     ├─ layout.tsx                   # sub-nav tabs
│     ├─ channels/page.tsx            # connect/reconnect/disconnect + expiry banner
│     ├─ team/page.tsx                # members + invitations (US-006/007) — MISSING today
│     ├─ ai/page.tsx                  # tone, auto-reply, discount cap, keywords
│     ├─ business-hours/page.tsx      # 7-day grid + away message
│     └─ plan/page.tsx                # usage meters + upgrade (owner)
└─ audit-logs → settings/audit/page.tsx  # queryable log UI (prd §4.6) — MISSING today
```

**Deviation noted:** spec says `[workspaceSlug]`; the built app uses
`[workspaceId]`. **Decision: keep `[workspaceId]`** — the API tenancy path is
`/w/:workspaceId`, slugs would need a resolve round-trip per navigation, and
the spec's own API contract never routes by slug. Flagged, not silent.

---

## 3. Design system — "Bondhu" (বন্ধু = friend)

The specs define zero visual identity. This section is the product
requirement ("beautiful, modern") made concrete and testable.

### 3.1 Principles
1. **Warm, not corporate** — this is a friend helping a seller, not a SaaS cockpit.
2. **Dense but breathable** — sellers scan 47 conversations with morning chai; information density wins, but with rhythm (8-px spacing grid).
3. **Motion = meaning** — animation only ever communicates state change (new message, status flip, AI thinking). Zero decorative animation loops.
4. **Dark-friendly** — 9 PM is peak selling hour in BD; dark mode is first-class, not an afterthought.

### 3.2 Tokens (CSS custom properties, `globals.css`)

```css
/* Light */
--bg: #f8f7f4;            /* warm paper, not gray */
--panel: #ffffff;
--border: #e7e4de;
--text: #1a1917;
--muted: #706c64;
--brand: #0d9488;         /* teal-600 — trust + freshness */
--brand-strong: #0f766e;
--brand-soft: #ccfbf1;
--accent: #f59e0b;        /* amber — taka, highlights */
--ai: #7c3aed;            /* violet — everything AI-authored */
--ai-soft: #ede9fe;
--ok: #16a34a;  --warn: #d97706;  --danger: #dc2626;
--radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
--shadow-1: 0 1px 2px rgb(0 0 0 / .04), 0 2px 8px rgb(0 0 0 / .04);
--shadow-2: 0 4px 12px rgb(0 0 0 / .08), 0 12px 32px rgb(0 0 0 / .06);

/* Dark (html[data-theme=dark] — class strategy, persisted, no FOUC:
   inline nonce'd script in <head> reads localStorage before paint) */
--bg: #12110f; --panel: #1c1a17; --border: #2c2925;
--text: #f0eeea; --muted: #8f8a81; --brand-soft: #134e4a;
--ai-soft: #2e1065; /* …full mirrored set */
```

### 3.3 Typography
- **UI:** `Inter` (variable, `next/font`, subset latin) — self-hosted, zero external requests (CSP + BD network reality).
- **Bengali:** `Noto Sans Bengali` (variable, `next/font`) — message text, previews, away messages. Falls back cleanly for Banglish (Latin) text.
- Scale: 12 / 13 (base) / 15 / 18 / 22 / 28. Tabular numerals for money and counts (`font-variant-numeric: tabular-nums`).

### 3.4 Component inventory (`src/components/ui/`)
Build these ~14 primitives once, use everywhere — **no component library**
(bundle budget, §5):

`Button` (primary/ghost/danger/icon; loading state swaps label for spinner with width preserved) · `Input`/`Textarea`/`Select` (floating focus ring in brand-soft) · `Badge` (status + AI variants) · `Card` · `Sheet` (mobile bottom sheet / desktop side panel) · `Dialog` (for 409 diff + destructive confirms) · `Toast` (stacked, bottom-right, swipe-to-dismiss) · `Skeleton` (shimmer) · `Tabs` · `Avatar` (initials, deterministic hue from id) · `EmptyState` (illustrated) · `Meter` (quota bars) · `Sparkline`/`BarChart` (pure SVG, no chart lib) · `Kbd`.

---

## 4. Motion language — "modern animation" made concrete

**Library: Motion (framer-motion successor, `motion/react`)** — LazyMotion +
`domAnimation` feature set only (~5 kB gz), tree-shaken. Everything else is
CSS transitions/keyframes. **Every animation respects
`prefers-reduced-motion`** (Motion's `useReducedMotion` + CSS media query —
fall back to opacity-only, 80 ms).

### 4.1 Global timing
| Token | Value | Use |
|---|---|---|
| `--ease-out-soft` | `cubic-bezier(.22,1,.36,1)` | entrances |
| `--ease-spring` | Motion spring `{stiffness:420, damping:32}` | list items, badges |
| fast | 120 ms | hovers, presses |
| base | 200 ms | fades, tab switches |
| slow | 320 ms | sheets, dialogs, page transitions |

**Rules:** animate only `transform` + `opacity` (compositor-only, no layout
thrash). Never animate during scroll. One `AnimatePresence` per list.

### 4.2 The signature moments (each maps to a spec behaviour)

| Moment | Animation | Spec source |
|---|---|---|
| **New conversation arrives** (socket `message.created`) | Row springs in from top: `y:-12→0, opacity:0→1, scale:.98→1` spring; unread dot does a single 1.4× pulse; row background flashes `--brand-soft` and fades over 1.2 s | user-story Act 5 "Rony's dashboard updates… unread badge"; CON-03 < 1 s |
| **New message in open thread** | Bubble enters `y:8→0` + opacity spring; auto-scroll only if user is at the bottom (else "↓ new message" pill fades in) | Act 6 |
| **AI is handling** | 🤖 badge with a subtle 2 s breathing glow (`box-shadow` pulse, pauses on reduced-motion); when AI replies, three-dot typing indicator morphs into the bubble | Act 6 "the 🤖 icon tells Rony the AI is handling" |
| **Handover flash** | Conversation row flashes amber twice + moves to top with FLIP layout animation (`layout` prop); toast "Nusrat needs a human — contradictory phone numbers" | Act 8 "Rony's dashboard flashes" |
| **Order status flip** (socket `order.updated`) | Status badge crossfades + springs (old scales to .8/fades, new from 1.15); row glows `--ok` once on Confirmed | Act 7 |
| **Take Over / Return to AI** | Mode badge morphs AI↔Human with a 200 ms crossfade; composer border color animates violet↔teal | Act 8 |
| **Quota meter** | Bar width animates on load (spring); at 80 % turns amber with one pulse; at 100 % turns red, AI-paused chip slides in | prd §2.11 banners |
| **CSV import** | Progress bar springs to each checkpoint (`import.progress` socket); per-100-row tick briefly shows "+100"; completion confetti-free ✓ draw-in (SVG stroke-dashoffset, 400 ms) | US-012 |
| **Skeletons** | Shimmer sweep (CSS gradient translate, 1.6 s linear infinite); content replaces skeleton with 150 ms crossfade — **no layout shift** (identical box sizes) | prd §4.2 |
| **Page transitions** | App-shell pages: content fades/slides `y:6→0` 200 ms on route change (template.tsx); sidebar link gets an animated active-indicator that slides between items (shared layout) | product req |
| **Auth screens** | Card enters `scale:.97→1 + y:10→0` spring; field validation errors shake once (±4 px, 240 ms) and settle | product req |
| **Dialogs/Sheets** | Backdrop fades; dialog springs `scale:.96→1`; mobile sheet slides from bottom with drag-to-dismiss (Motion drag) | product req |
| **Degraded banner** | Slides down from top (height auto-animate); reconnect state shows animated ellipsis; recovery slides it away + green toast "Back online — synced" | C-10 |
| **Socket status dot** | Green breathing when connected; amber blink while backing off; after 20 attempts, red + "Reconnect" button (C-8) | §12.8 |
| **Number tickers** | Analytics stat cards count up from 0 on first view (Motion `animate`, 600 ms, once) | Act 11 overview |

### 4.3 Micro-interactions
- Buttons: `scale(.98)` on press (120 ms), spring back.
- Copy-to-clipboard (order code, requestId): icon morphs to ✓ for 1.2 s.
- Hover on rows: background + 2 px translate-x of the chevron.
- Toasts stack with Motion layout animations; errors persist (manual dismiss), successes auto-dismiss at 3.5 s.

---

## 5. Performance — "super optimized" made concrete and CI-enforced

### 5.1 Budgets (build fails / PR flagged if exceeded)
| Metric | Budget | How enforced |
|---|---|---|
| First Load JS, app-shell route | **≤ 170 kB gz** (Next baseline ~105 kB + ~65 kB ours) | `next build` output check in CI |
| Per-route incremental JS | ≤ 25 kB gz | same |
| LCP (Fast-3G throttled, mid-tier device) | < 2.0 s | Lighthouse CI budget file |
| CLS | < 0.05 | Lighthouse CI |
| INP | < 200 ms | Lighthouse CI |
| Fonts | 2 variable fonts, `display: swap`, preloaded, self-hosted | next/font (automatic) |

### 5.2 Techniques (all mandatory)
1. **RSC-first**: inbox first page, analytics summary, settings reads are **server components** (data fetched server-side with the session cookie; zero client fetch waterfall on first paint). Client components only where interactivity/sockets demand.
2. **Streaming + Suspense**: app-shell renders instantly; each pane streams with its skeleton as the fallback (`loading.tsx` per route).
3. **`socket.io-client` lazy-loaded** (`next/dynamic`, no SSR) — it is the single heaviest client dep; the shell must not wait for it.
4. **Motion via LazyMotion** — `domAnimation` only, loaded with the app shell chunk.
5. **List virtualization** for >100 rows (conversations at scale, orders, audit logs): windowing hook or `content-visibility: auto` + `contain-intrinsic-size` (prefer the CSS route — zero JS).
6. **Optimistic UI everywhere it's safe**: reply appears instantly as `queued` (matches the real message lifecycle — the backend has a `queued` status; no lie), take-over flips the badge optimistically and reverts on 409. Order confirm is **NOT optimistic** (stock race — spec DF-02: show the spinner, surface 422 clearly).
7. **Delta merges** on socket events and reconnect (`updatedSince`) — never refetch a full list that's already rendered (C-8).
8. **`revalidate` per C-15**; `router.refresh()` scoped, never global.
9. **Images**: `next/image`, AVIF/WebP, profile pics lazy + blur placeholder from deterministic avatar hue.
10. **No barrel-file imports** from `@inboxbondhu/contracts` in client code — import exact schemas (tree-shaking; zod stays out of chunks that don't validate).
11. **Prefetch on hover/viewport** for sidebar links (Next default) but `prefetch={false}` on the audit-log and analytics heavy routes.
12. **Web Vitals reporting** → `console` in dev, log endpoint in prod (feeds the §15.5 observability story).

---

## 6. Screen-by-screen functional spec

Every screen lists: data (endpoint), realtime, states, and its acceptance
criteria source. All list screens have: skeleton → content / empty-state /
error-state (with retry) — the four states are mandatory.

### 6.1 Inbox (`/inbox`) — THE screen (Act 6 layout)
- **Layout:** split-pane ≥ 1024 px (list 380 px + thread flex); mobile: list only, thread navigates.
- **Data:** RSC first page `GET /conversations` (20); client takes over with `updatedSince` merges.
- **Realtime:** `message.created` → row spring-in/update + preview swap; `conversation.updated` → badge morphs.
- **Row:** avatar (initials, provider glyph FB/IG), name, preview (1 line, Bengali font), relative time (Dhaka, auto-updating), unread count chip, 🤖/🙋 mode badge, status badge.
- **Filters:** status tabs (All/Open/Pending/Resolved) with sliding active indicator; mode toggle; search (`q`, 300 ms debounce).
- **Sort:** `lastMessageAt` desc (spec: primary inbox sort key).

### 6.2 Thread (`/inbox/[id]`)
- **Header:** customer name, window countdown chip ("Window closes in 3 h" — from `metaWindowExpiresAt`; red when < 1 h; explains P-01 refusals *before* they happen), mode + status badges, Take Over / Return to AI / Resolve / Reopen.
- **Return to AI blocked** mid-capture (422) → dialog explains "finish or cancel the draft order first" (spec §9-P4).
- **Bubbles:** customer left; AI violet-tinted with 🤖 + confidence-invisible (never show internals); agent teal-tinted with author name. Failed messages: red outline + reason + retry button (hidden for `WINDOW_EXPIRED` — P-01 "retries will never succeed").
- **Media:** image bubbles lazy; `fetchStatus:failed` → C-14 fallback with Messenger deep link.
- **Composer:** Idempotency-Key per send (C-7); optimistic bubble in `queued` state → status ticks update via refetch/socket; disabled with explanation when window expired.
- **Open-order card** (spec #41 response): sticky above composer when present; status animates.

### 6.3 Orders (`/orders`)
- Table (desktop) / cards (mobile). Row: code, customer, zone, ৳total (tabular), fulfillment badge (7 states, exact spec names), payment badge, Dhaka date.
- Actions per state machine: Confirm (AwaitingConfirmation), Cancel (non-terminal; Processing→Cancel only owner/admin — hide via `permissions.ts`, server still enforces), Ship/Deliver transitions.
- Confirm failure 422 (out-of-stock race, DF-02) → toast + row shake; **surface it clearly, never silently drop the item** (spec wording).
- `order.updated` socket → badge crossfade animation.
- Filters: fulfillment/payment status, date range.

### 6.4 Catalogue (`/catalogue`)
- Product table: SKU, name, ৳price, stock (reserved shown as `12 (3 reserved)`), status badge, variants expander (animated height).
- CSV import: drag-drop zone (dashed border animates on drag-over), progress via `import.progress` socket (field names: `lastProcessedRow`/`totalRows`/`successCount`/`failureCount`), per-row error report downloadable/expandable after completion (US-012 acceptance), cancel button.
- Archive → restore flow (DELETE = archive per spec).
- Plan-cap error (PLAN_LIMIT_EXCEEDED) → upgrade CTA linking to plan settings.

### 6.5 Knowledge (`/knowledge`)
- Draft→Approved flow with the explanatory copy: "The AI can only say approved things" (spec: retrieval reads approved only).
- Approve = primary action with a satisfying ✓ draw-in; edit-after-approve warns "editing returns this to draft" (US-014).
- List grouped by status; search.

### 6.6 Analytics (`/analytics`) — Fatima's morning view (Act 11)
- **Overview cards exactly per the Act 11 box:** new conversations, AI-resolved (+%), handed to human, waiting for reply, orders created, AI responses sent, avg first-response. Number tickers on load.
- **Primary metric hero:** conversion rate (confirmed ÷ conversations — prd §1.5) — biggest card.
- Bar series (Dhaka-day) for conversations/orders/AI replies — pure SVG, animated bar growth on first view, tooltips.
- Range picker: 7/30/90 d. RSC with 60 s revalidate (C-15).
- "⚠️ N handovers pending" card → deep-links to inbox filtered pending.

### 6.7 Settings — five sub-pages (spec layout) + audit
- **Channels:** connection cards (page name, ID, status, connectedAt); expiry warning banner with **[Reconnect Facebook Page]** exactly per Act 9's box; connect CTA → OAuth redirect; 502 explained when Meta creds absent.
- **Team** (US-006/007 — new): members table (name, email, role, joined), role change (If-Match; admins can't touch owner), remove with confirm dialog (5-step cascade warning), invitations section (pending list w/ expiry countdown, revoke, invite form: email + role; 20-pending cap error surfaced).
- **AI:** toggles + tone select + discount-cap slider (0–50) + handover-keywords chip input. Saves per-field with If-Match; 409 → C-6 dialog.
- **Business hours:** 7-day grid (day chips toggle closed; time pickers), away-message textarea (Bengali font), preview of "away" behaviour copy.
- **Plan** (owner): current plan card, two animated quota Meters (conversations, products), 80 %/100 % states, upgrade/downgrade buttons with confirm; `quota.warning` socket updates the meter live.
- **Audit logs** (prd §4.6 — new): filter bar (actor, action type, resource type, date range), virtualized table, requestId copy button, cursor pagination ("Load more" with skeleton rows).

### 6.8 Auth screens
Per user-story Act 1–2 + US-001..005: register (with storeName, zxcvbn-style
strength meter animating through red→amber→green), "check your email" success
state, `verify/[token]` (auto-verify on mount: spinner → animated ✓ →
redirect; already-verified and expired-token states per US-002), login
(lockout → `/unlock` redirect with the attempt-count message), forgot/reset
(never leaks account existence), unlock (OTP input with auto-advance boxes).

### 6.9 Marketing (`(marketing)/`)
Static, RSC-only, zero client JS except the theme toggle. Landing: hero with
the product one-liner in English + Bengali, animated (CSS-only) mockup of the
inbox, feature triad (AI Banglish replies / order capture / one inbox),
pricing table, CTA → register. Ships with `revalidate: 3600`.

---

## 7. Cross-cutting behaviours

### 7.1 Error UX (maps the 18 canonical codes)
| Code(s) | UX |
|---|---|
| VALIDATION_FAILED | inline field errors (shake), map `details[].path` to fields |
| UNAUTHENTICATED / SESSION_REVOKED | transparent refresh once → else redirect `/login?next=` |
| INSUFFICIENT_PERMISSIONS | toast "You don't have permission" (UI should have hidden it — log to console as a permissions.ts bug signal) |
| WORKSPACE_FORBIDDEN | redirect to `/workspaces` with toast |
| NOT_FOUND | contextual empty/error state |
| **VERSION_CONFLICT (409)** | **C-6 dialog: "Someone else changed this" + field-level diff (from `conflictingFields` + refetched values) + [Reapply my change] / [Keep theirs]** |
| INVALID_STATE_TRANSITION | toast with the server message (it names the states) |
| DUPLICATE_RESOURCE | toast "already being processed" |
| BUSINESS_RULE_VIOLATION (422) | prominent toast, message verbatim (window expired, out of stock, mid-capture) |
| ACCOUNT_LOCKED | redirect `/unlock` |
| PRECONDITION_REQUIRED (428) | should be impossible — log loudly, generic toast |
| RATE_LIMITED / PLAN_LIMIT_EXCEEDED | toast + Retry-After countdown / upgrade CTA |
| NOT_IMPLEMENTED | "Coming soon" chip (payment links) |
| UPSTREAM_FAILED | "Meta is unreachable — try again" |
| DEGRADED_MODE | global banner takes over messaging |
| unknown 500 | toast with copyable `requestId` |

### 7.2 Realtime provider (existing `lib/socket.ts`, upgraded)
- C-8 backoff verbatim; `lastEventAt` tracked; reconnect → one `updatedSince` fetch per visible list.
- Event bus context (already built) + typed event map from this spec's §4.2 table.
- `session.revoked` → immediate redirect with toast "Your access was removed".
- Tab visibility: when hidden > 5 min, on focus do a silent `updatedSince` sync (don't trust a long-idle socket).

### 7.3 RBAC UI matrix (`lib/permissions.ts` — C-9)
Viewer: read-only everywhere (composers/actions hidden, PII masked per spec —
API already nulls it; UI shows "hidden for viewers" hint). Agent: reply,
take-over, resolve, ship/deliver, retry non-payment jobs. Admin: + products,
knowledge, channels, team (not owner), settings, analytics, audit, discounts,
cancel-processing. Owner: + plan, transfer, deactivate. **Every hidden control
is also server-enforced — the matrix only prevents confusing 403s.**

### 7.4 Accessibility
Focus rings always visible (brand-soft, 2 px); dialogs/sheets trap focus +
restore; all animations gated by `prefers-reduced-motion` (§4); status
conveyed by text+icon, never color alone; keyboard: `j/k` conversation nav,
`Enter` open, `Esc` close thread/dialog, `/` focus search; live regions
(`aria-live=polite`) for toasts and new-message announcements; WCAG AA
contrast in both themes (tokens pre-checked).

### 7.5 i18n posture
UI chrome in English (v1, per existing product copy); customer content
(messages, away messages, FAQ) renders with Bengali font support everywhere.
String table extracted to `lib/strings.ts` from day one so a `bn` locale is a
file, not a refactor. Dhaka-relative times ("2 min ago", "গতকাল" deferred).

---

## 8. Architecture rules

1. **State:** server state via RSC + fetch-on-navigation + socket deltas. A
   tiny client store (React context per domain, as today) — **no
   Redux/TanStack Query** unless list complexity forces it (budget first).
2. **Types:** `lib/types.ts` is DELETED; import from `@inboxbondhu/contracts`
   (C-11). Where contracts lack a response type, add it to contracts — the
   API and web must share one source (this is what caused audit H-2/M-1/M-2).
3. **api-client:** keep the existing envelope/CSRF/If-Match/Idempotency/refresh
   client; add typed wrappers per endpoint co-located in `lib/api/{domain}.ts`.
4. **File conventions:** RSC by default; `"use client"` only at interaction
   leaves; each route: `page.tsx` + `loading.tsx` (skeleton) + `error.tsx`
   (retry boundary).
5. **Testing:** Playwright smoke pack (auth → inbox → reply → order confirm →
   settings each render + one action), axe-core pass on every route, and the
   Lighthouse CI budgets from §5.1. Visual snapshots for the component library.

---

## 9. Build order (frontend phases)

| FE Phase | Scope | Gate |
|---|---|---|
| **F0** | Design system: tokens, dark mode, fonts, the 14 primitives, motion setup (LazyMotion), theme toggle, budgets wired into CI | Storybook-less demo route renders all primitives; budgets pass |
| **F1** | App shell: sidebar (animated active indicator), banners (degraded/quota/expiry), socket provider upgrade (C-8 verbatim), toasts, contracts-import migration (kills audit L-3) | shell < 170 kB; reconnect drill |
| **F2** | Inbox + Thread rebuilt to §6.1–6.2 with all signature animations; optimistic reply; window countdown | CON-03 demo: DM → animated row < 1 s |
| **F3** | Orders + Catalogue + Knowledge to §6.3–6.5 (import UX, 409 diff dialog, state-machine actions) | 20-way confirm race shows 1 ✓ + 19 clean 422 toasts |
| **F4** | Settings ×5 + Team + Audit logs + Plan meters (§6.7) | every RBAC state renders correctly ×4 roles |
| **F5** | Analytics (Act 11 view) + Auth polish (verify/reset pages, strength meter) + Marketing pages | LCP < 2 s on throttled profile |
| **F6** | A11y pass, Playwright pack, Lighthouse CI, final budget audit | all §5.1 budgets green in CI |

Each phase: same workflow as backend — implement → gates → report → commit.

---

## 10. Definition of Done (whole frontend)

- [ ] Every §2 route exists with loading/error/empty/content states
- [ ] All §4.2 signature moments implemented + reduced-motion fallbacks
- [ ] §5.1 budgets green in CI (bundle, LCP, CLS, INP)
- [ ] C-1…C-15 each verifiably honoured (checklist in the phase reports)
- [ ] A DM sent to a connected Page animates into the inbox in < 1 s (needs Meta creds for the full loop; socket-injected demo until then)
- [ ] Zero hand-written duplicate API types (contracts imports only)
- [ ] Four-role RBAC walkthrough recorded in the report
- [ ] Dark + light themes complete; axe-core clean on every route
