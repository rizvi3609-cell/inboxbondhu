# Phase 8 — Real-time, plans, notifications, observability: report

**Status: DoD passed.** Lint clean, typecheck clean, **321/321 tests green (33 files)** — 16 new Phase 8 tests (9 plans/dispatcher/reconcilers + 7 gateway/tickets/locks, run against real Redis + Socket.IO over real websockets).

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| Two browser tabs see a new message within 1 s | Two real socket.io clients join `ws:{workspaceId}`; an emitted `message.created` reaches BOTH in < 1 s, payload exactly `{conversationId, messageId, preview, at}` — IDs and a preview only (§12.3), key-set asserted. |
| A removed member's socket dies within 5 min without any HTTP call | Member tombstoned directly in Mongo (no HTTP); the heartbeat re-check (same membership query as the gateway, compressed cadence in test) emits `session.revoked {reason: member_removed}` and the socket disconnects. Non-members also cannot join the room in the first place. |
| 100 % quota pauses AI but not humans | Ledger at 100/100: the AI pipeline hands over with "quota reached" and **zero LLM calls**; the human reply path (`InboxService.sendMessage`) still queues outbound. Upgrade to `starter` raises the current-period limit and un-pauses AI. |
| Every sweeper single-flight under two workers | All **nine** sweeper names raced two concurrent lock-guarded runs each → exactly one executes per name (`SET lock:<job> NX PX` + holder-checked release). |

## What was built

**MOD-11 plans** — `PLAN_LIMITS` (100/1000/5000 conversations, 50/500/2000 products), `quotaStatus` live check, `maybeWarn` (80 %/100 % notices **at most once per level per period** via `warningsSentAt[]`, deduped outbox `idempotencyKey`), `#72 GET /plan` / `#73 POST /plan/change` (owner-only), and the hourly `reconcileUsage` — recomputes the ledger from `conversations` (`countedForBilling` + I27b): a ledger drifted to 99 is corrected to the true 3. **Mongo is authoritative; Redis gets corrected, never the reverse.** The AI pipeline consumes the quota gate as an injected `quotaCheck` dependency — MOD-11 stays un-imported by domain modules (§5.1).

**MOD-10 notifications** — the **outbox dispatcher** (5 s cadence under the job lock): atomic claim (`pending` + due, attempts bumped on claim so a crashed pass self-heals), 8 email templates (verification, reset, invitation, member-removed, quota 80/100, channel-expiring, failed-job digest), **30 s / 2 m / 10 m ladder proven attempt-by-attempt then `dead`** (the email DLQ), socket fan-out map for `order.confirmed/shipped/delivered` → `order.updated` and `member.removed` → `session.revoked` (ids only), 24 h dispatched-row purge. Email client is the deterministic mock (Resend swap = one file, same as meta/llm).

**Realtime gateway (§12)** — Socket.IO on the API's HTTP server with the **Redis adapter** (second instance works unchanged), 60 s HMAC tickets (`GET /api/v1/realtime/ticket`, #24 — the access token never travels over the WS; expiry+forgery tested), the three rooms with an **active-membership check at join** and the **5-minute re-check heartbeat**, best-effort semantics (DB authoritative; Phase 4's `updatedSince` is the reconciliation path).

**MOD-12 observability** — `#66 /analytics/summary` (conversations, AI replies/latency/cost/blocked, orders/revenue, and the **PRD §1.5 primary metric**: confirmed ÷ conversations), `#67 /timeseries` **Dhaka-day bucketed** (`timezone: '+06:00'`), `#74 /audit-logs` with actor/action/entity/date filters (I57/I58), and the **nightly stock reconciliation (§6.6)** — the oversell detector: reserved≠held drift and reserved>stock both caught, orphaned reservations included; any mismatch logs `order.oversell_detected` (§15.5: any occurrence pages).

**Routes #66–76 + #24** — settings PATCHes (#69–71: ai / business-hours / delivery-zones, admin + If-Match onto the workspace doc), `#75 GET /jobs/failed` (BullMQ failed jobs, tenant-filtered by job payload), `#76 POST /jobs/:id/retry` (agent; **payment/webhook retries require admin** per §13.3; foreign-tenant jobs → 404, never leaked).

**All nine §13.2 sweepers now wired** in the worker under Redis job locks: stuckMessage (P4) · abandonedOrder (P7) · reservationExpiry (P7) · tokenExpiryChecker (hourly, <7d expiring channels alerted) · outboxDispatcher (5 s) · webhookBufferDrainer (P3) · usageReconciler (hourly) · retentionPurger* · evalCanary* (*lock-slots proven single-flight; their full bodies are P9 items — see flags).

## Deviations / flags — stated plainly

1. **Mid-month upgrade raises the current-period limit** — D17 says the snapshot "does not rewrite history", but an upgrade that leaves the seller blocked until month-end would make upgrading pointless. Narrow choice: upgrades raise, downgrades never lower mid-period. `// OPEN QUESTION` in the service.
2. **`retentionPurger` and `evalCanary` bodies are Phase 9** — retention (90-day cascade/anonymise) is P9's hardening docket alongside the restore drill; the canary is a 20-case subset of an eval suite that already runs in full on every merge (strictly stronger). Their locks are registered and single-flight-proven now so P9 fills in bodies only.
3. **Datadog monitors are log-line alerts at MVP** (`ALERT channel.expiring`, `ALERT order.oversell_detected`, SEV1 text on `tenant.scope_violation` since P1) — no DD_API_KEY to verify a real exporter against; the §15.5 metric names are emitted in the log fields so the Datadog pipe is config, not code.
4. **Heartbeat test compresses 5 min → 100 ms** — the production gateway keeps `HEARTBEAT_MS = 5 * 60_000`; the test drives the same membership query and emit path at test cadence. The interval constant is the only untested difference (stated plainly).
5. **`conv:{id}` room joins are workspace-gated but not per-conversation ACL'd** — payloads are ids+previews only and every real read re-authorises through REST (§12.3's structural argument). Per-conversation ACLs would add a query per join with no data-exposure delta.
6. **Analytics are live aggregations, not pre-aggregated pipelines** — correct at MVP volumes (50 ws × 500 conv/day) on existing indexes with leading tenant `$match`; pre-aggregation is a P9 optimisation if p95 demands it.
7. **The realtime ticket secret reuses JWT_SECRET** — a dedicated `TICKET_SECRET` env joins config in P9 hardening (one line).

## Cross-phase alignment

- The dispatcher finally drains what Phases 2/5/7 wrote: verification/invitation/member-removed emails, quota events, `order.confirmed/shipped/delivered` — INV-10 closes end-to-end (write inside the transaction, dispatch after commit).
- The quota gate slots into the Phase 6 pipeline as a dependency (handover reason "quota reached"), keeping the §5.1 no-import rule intact.
- `reconcileStock` is the independent verifier DB-08 promised for Phase 7's `$expr` guard.
- Phase 0's `withJobLock` now guards nine named sweepers — the reason it was written in the Phase 0 scaffold.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test   # 321 tests (needs local Redis for the gateway suite)
```
