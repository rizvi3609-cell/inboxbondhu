# FE Phase 4 — Settings ×5 + Team + Audit log: report

**Status: done.** Typecheck clean, lint clean, **355/355 tests green**, bundle budget green — now **21 routes**, all ≤ 170 kB (settings pages 154–155 kB first-load, inside budget with Motion shared).

## What was built — the spec's settings layout, finally real

`settings/` went from one monolithic page to the architecture.md structure:
`layout.tsx` (sub-nav with sliding underline via `layoutId`) + `channels/ team/ ai/ business-hours/ plan/ audit/` + an index redirect to channels.

### Channels (`settings/channels`) — Act 3 + Act 9
Connection cards (provider tile, page name, status badge, connected date); **the Act 9 expiry banner verbatim** ("Your Facebook Page connection has expired… [Reconnect Facebook Page]") driven by channel status; connect/reconnect → OAuth redirect with the **502-when-Meta-unconfigured explanation** (OQ interim behaviour: honest message, not a fake error); disconnect behind a confirm dialog that states the real semantics (token destroyed, history stays). Consumes #35's bare array per the audit-H-2 note in views.ts.

### Team (`settings/team`) — US-006/007, the screen that never existed
- Members list: avatar, name/email/joined, role badge; **role select for non-owners** (PATCH #30 — owner-guard is the service's; the owner row shows "changes only via ownership transfer" instead of controls).
- **Removal dialog spells out the T2 5-step cascade** before the click: sessions end, conversations unassign, their invitations revoke, membership tombstones, audit row. The user consents to what actually happens.
- Pending invitations with the /20 cap indicator, expiry countdown, revoke.
- Invite form (email + role from the 3 assignable roles — owner not offered, matching the API's hard rule); server messages for the cap/duplicate/verified-email rules surfaced verbatim.
- Role-change failure reloads to server truth so the select never lies.

### AI assistant (`settings/ai`)
Animated switch toggles (master + auto-reply, each with a consequences hint), tone select, **discount-cap slider 0–50** (amber >20, grounding-gate framing in the copy), **handover-keywords chip input** (Enter-to-add, Bengali-capable, dedup). Explicit **Save sends only changed fields** with If-Match; **409 → the C-6 ConflictDialog** with per-field diff, Reapply against the refreshed version. Dirty-state indicator; Save disabled when clean.

### Business hours (`settings/business-hours`)
Master toggle dims the grid; **7-day grid** with day chips toggling closed and time pickers per day; **overnight windows labelled** ("spans midnight" — the kernel supports them, the UI acknowledges them); Bengali away-message textarea; the **P-09 once-per-customer-per-day rule stated under the field** so nobody wonders why the message didn't repeat.

### Plan & usage (`settings/plan`)
Current-plan card with the AI-paused badge; **animated Meters** (conversations + products) with 80 % amber pulse / 100 % red; `quota.warning` socket refreshes live; plan cards with Switch buttons (owner) and a confirm dialog whose copy states the real semantics — **upgrades raise the current period immediately; downgrades apply next month** (the P8 OPEN QUESTION resolution, now user-facing). Non-owners degrade gracefully: usage via #68, "plan changes are owner-only" note (Promise.allSettled on the 403).

### Audit log (`settings/audit`) — prd §4.6, the other missing screen
Filter bar exactly per the PRD: **action prefix, resource type, date range** (+ the service supports actorId — see flags); 250 ms debounced; cursor pagination with Load more; rows show Dhaka timestamp, actor badge (🤖/⚙/role), action, resource ref; **requestId copy button** (pairs with server logs — the §15.3 promise made usable); **before/after diff expansion** (amber/green panes). `content-visibility: auto` keeps long lists cheap (§5.2 virtualization-by-CSS).

### Shell fix (F1 flag closed)
`ChannelExpiryBanner` now fetches channel status itself (silent on 403 for non-admins) and links to `settings/channels` — the F1 "prop-driven, currently null" deviation is gone.

## Gates & evidence
| Gate | Result |
|---|---|
| Bundle budget | **21 routes** ≤ 170 kB ✅ (new pages 154–155 kB) |
| Tests | 355/355 ✅ — one flaky run first (seed test 120 s timeout) caused by the F3 drill's api+worker+mongod still running and starving the box; clean rerun after stopping them. Environment contention, not code — stated plainly. |
| tsc / eslint | clean (one unused-import caught by the build lint, removed) |

## Deviations / flags
1. **actorId filter field not rendered** — the API supports it, but actorIds are ObjectIds; a raw-id input is useless to humans. The right control is a member dropdown, which wants the members list joined in — small follow-up, flagged rather than shipping a bad input.
2. **Role changes send no If-Match** — #30's route validates `ChangeRoleBody` only (membership OCC is inside the service via version, but the route doesn't require the header). UI matches the API as-built. If the backend later demands If-Match here, the client helper already supports it.
3. **Channel `status` values for the expiry banner** — model uses `active|expired|disconnected` (+`expiring` marked by tokenExpiryChecker). The banner keys on `expired|expiring`; a status the sweeper never sets simply never shows. No invented states.
4. **recordCodPayment UI still deferred** (F3 flag stands) — it's an orders-domain action; wiring it into the order detail expander is a small follow-up, not a settings concern.
5. Marketing/verify/reset pages remain F5 scope, unchanged.

## How to verify
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:web   # 21 routes, budget OK
# live: Settings → tabs slide; Team → invite/role/remove dialogs; AI → edit in
# two tabs to trigger the 409 diff; Plan → meters animate; Audit → filter + diff
```
