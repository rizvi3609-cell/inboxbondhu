# FE Phase 1 — App shell: report

**Status: done.** Typecheck clean (8 projects), lint clean, **355/355 tests green** (+3 new §12.8 backoff tests), bundle budget green (all 15 routes ≤ 170 kB; workspace routes 107–111 kB).

## What was built

### 1. Contracts migration — audit L-3 / spec C-11 CLOSED
- **`packages/contracts/src/views.ts`** (new): every API response view type the dashboard consumes — Me/Workspace/Member/Invitation, Channel (documented as THE one bare-array list), ConversationListItem/Detail (PII-nullable fields typed), Message, Product/Import (the exact `lastProcessedRow/successCount/failureCount` names), KnowledgeItem, Order (all 7 fulfillment + 5 payment statuses as literal unions), Quota/Plan/Analytics/Timeseries/AuditLog, **and the typed `RtEventMap`** for all 6 socket events (§12.3 payloads).
- Deliberately **type-only**: `import type` erases at compile time, so zod never enters a client bundle through this file. Dates are `string` (JSON wire truth).
- **`apps/web/src/lib/types.ts` DELETED.** All 7 pages repointed to contracts; `taka`/date helpers moved to `lib/format.ts` (+ `relativeTime`, `countdown` for F2's window chip).
- The migration **immediately caught a real bug**: the inbox page read `c.customerName` — a field that never existed in any API response. Exactly the class of drift C-11 exists to prevent; fixed.

### 2. Socket client rebuilt — C-8 / §12.8 VERBATIM
`lib/socket.ts`: socket.io's built-in reconnection is **disabled**; our policy runs the schedule:
- `backoffDelay(n) = min(30s, 500ms·2^n)·random()` — full jitter, exported and **pinned by unit test** (attempt-by-attempt values, cap at 30 s through attempt 25, jitter=0 legal).
- **Hard cap 20 attempts → `gave_up` state → the UI's manual "Reconnect" button** (resets the budget on human click).
- Fresh 60 s ticket fetched per attempt (they expire faster than a backoff run).
- `socket.io-client` now **dynamically imported** — the app shell never waits for it (§5.2 item 3).
- Typed events end-to-end: `onEvent<K extends keyof RtEventMap>` — consumers narrow by event key, no more `Record<string, unknown>` (which had been hiding the `customerName` bug).

### 3. App shell
- **`Sidebar`**: sliding active pill via Motion `layoutId` (FLIPs between nav items on route change — §4.2), emoji nav icons, socket status dot (green breathing / amber blinking / red gave-up per §12.8 states), workspace switcher + theme toggle + sign-out. **Collapses to a 56 px icon rail below 1024 px** (labels hidden via CSS, zero JS).
- **`template.tsx`**: §4.2 page transitions — content fades/slides y:6→0 in 200 ms on every in-shell navigation.
- **Four global banners** (`Banners.tsx`), each height-auto-animated in/out:
  - `DegradedBanner` — /healthz poll, C-10 wording;
  - `QuotaBanner` — live via the `quota.warning` socket (80 amber / 100 red + "AI paused, humans keep working"), links to plan settings;
  - `ChannelExpiryBanner` — Act 9's "Reconnect Facebook Page" CTA (wired to data in F4 when settings/channels lands; prop-driven now);
  - `SocketGaveUpBanner` — the §12.8 manual Reconnect.
- **Workspace layout** rebuilt on MotionRoot + ToastProvider + the typed realtime context (`connState` + `retryNow` added). §7.2 tab-visibility rule implemented: hidden > 5 min → focus bumps `reconnects`, every list runs one `updatedSince` merge.

### 4. Route skeletons (spec §8.4)
`loading.tsx` for inbox / orders / catalogue / analytics — box-matched shimmer skeletons (no CLS), streamed by Next while RSC data resolves.

## Numbers
| Gate | Result |
|---|---|
| Bundle budget | 15 routes, all ≤ 170 kB (workspace shell 107–111 kB) ✅ |
| Motion cost | now in a shared chunk; `/design` route dropped 48 kB → 2.6 kB route-specific |
| Tests | 355/355 (new: 3 backoff-formula pins) |
| tsc / eslint | clean across all 8 projects |

## Deviations / flags
1. **`ChannelExpiryBanner` renders from a prop, currently `null`** — the channels-status fetch belongs to F4's settings work; wiring a shell-level fetch now would duplicate it. The banner component + animation are done and demo-able.
2. **Old P9 page bodies still legacy-styled** (inbox/orders/etc.) — they now import contracts types (C-11 holds) but their rebuild to the F2/F3 designs is exactly what F2/F3 are.
3. The `session.revoked` socket event routes through both `onEvent` and `onRevoked` — deliberate: pages may want the event (toast) while the shell owns the redirect.
4. `pgrep`-killed a stale preview server during verification (port conflict) — sandbox hygiene, not a code issue.

## How to verify
```bash
pnpm typecheck && pnpm lint && pnpm test        # 355
pnpm build:web                                   # budget gate
# live: /design (primitives) · log in → sidebar pill slides between routes,
# degraded banner appears if the API is down (that's C-10 working)
```
