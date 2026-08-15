# Phase 9.1 — Cross-phase synchronization fixes (audit remediation): report

**Status: done.** Lint clean, typecheck clean, drift clean, **352/352 tests green (38 files)** — 5 new production-path tests. Web production build clean. Every issue from the 10-phase synchronization audit is fixed and proven.

## What the audit found, and what was fixed

### H-1 (HIGH) — Realtime events were never produced in production ✅ FIXED
The Phase 8 gateway worked; nothing fed it. The dashboard subscribed to five events; zero had a production producer, and the worker ran the outbox dispatcher without `emitSocket`.

**The fix — one bridge, five producers:**
- **`packages/core/src/modules/notifications/realtime.ts`** (new): `rt:events` Redis pub/sub bridge. Producers anywhere (worker or api) publish `{room, event, payload}`; every api instance's gateway subscribes and fans out to its local room members. Fire-and-forget by design (§12.4 best-effort; P-02: Redis down = realtime degrades, never blocks).
- **Gateway** (`apps/api/src/realtime/gateway.ts`): dedicated bridge subscriber connection (kept separate from the adapter's psubscribe space), garbage-tolerant parser.
- **Producers wired, all by injection (§5.1 — no domain module imports notifications):**
  | Event | Producer | Wire point |
  |---|---|---|
  | `message.created` (inbound) | `processWebhookEvent(dedupeKey, notify)` | worker ingest processor |
  | `message.created` (agent reply) | `InboxService` 3rd ctor arg | api bootstrap |
  | `conversation.updated` | `InboxService.update` after OCC success | api bootstrap |
  | `import.progress` | `processImport(…, notify)` at every checkpoint + completion | worker csv processor |
  | `order.updated` / `session.revoked` / `quota.warning` | `dispatchOutboxBatch({ email, emitSocket: notify })` | worker outbox sweeper |
- **Dispatcher SOCKET_EVENTS** gained `quota.warning`/`quota.blocked` → `quota.warning {level: 80|100}` (audit M-3; email half unchanged).

### H-2 (HIGH) — Channels list shape mismatch ✅ FIXED
`#35 GET /channels` returns a bare array (the API is frozen); the web page expected `{channels}`. Web side corrected to `api<Channel[]>` with a comment marking it as the one unwrapped list endpoint.

### M-1 (MEDIUM) — Orders table "Invalid Date" ✅ FIXED
`OrdersService.serialise()` now includes `createdAt` (additive, non-breaking — verified against the create AND list paths by test). Web renders `'—'` for the null fallback.

### M-2 (MEDIUM) — Import progress field names ✅ FIXED
Web `ImportStatus` re-typed to the real contract: `lastProcessedRow` / `successCount` / `failureCount` / `totalRows` — the same names used by `GET /imports/:id` **and** the new `import.progress` socket payload (asserted key-by-key in the test). Progress bar and error count now live-update.

### M-3 (MEDIUM) — quota + import events had no socket path ✅ FIXED (inside H-1)

### L-1 (LOW) — Orphaned queues ✅ RESOLVED AS DOCUMENTATION
`email` / `notification` / `dead-letter` are §13.1-mandated registrations, so they stay — now with explicit RESERVED comments in `queues.ts` explaining that email flows through the outbox sweeper (exactly-once via `idempotencyKey`) and dead letters live in per-queue failed sets read by #75. Removing them would contradict the spec; misleading silence was the actual bug.

### L-3 (LOW) — Parallel web types ✅ MITIGATED
The three mismatches were exactly where hand-written web types diverged from reality. Fixed types now carry comments pinning them to their server contract. Full migration of `apps/web/src/lib/types.ts` to `@inboxbondhu/contracts` imports remains the structural cure — deferred deliberately (contracts ships Zod + mongoose-adjacent types; the web bundle should not pull zod for display types without tree-shaking verification). Flagged, not silently dropped.

## The test that was missing all along

`apps/api/src/__tests__/phase91.test.ts` — **production-path realtime with ZERO manual `gateway.emit` calls** (the Phase 8 suite's flaw, stated plainly in the audit):

1. **Inbound DM end-to-end**: raw HMAC-signed webhook → `intakeWebhook` → `processWebhookEvent(+notify)` → `rt:events` → gateway bridge → **real socket.io client receives `message.created` < 1 s**, payload keys exactly `{at, conversationId, direction, messageId, preview}` (§12.3).
2. **Agent reply**: `InboxService.sendMessage` (wired exactly as the api bootstrap wires it) → other tab receives the outbound preview.
3. **Outbox fan-out**: an `order.confirmed` row + `dispatchOutboxBatch({email, emitSocket})` (worker wiring verbatim) → socket receives `order.updated {orderId, orderCode}`.
4. **CSV progress**: 120-row import → ≥2 `import.progress` events (checkpoint + completed) with the exact dashboard field names asserted.
5. **M-1 regression guard**: order create + list both serialise `createdAt`.

## Cross-phase alignment statement

- No API contract changed (M-1 is additive; H-2/M-2 were consumer-side).
- No schema, index, or transaction touched — `jsonschema:check` clean.
- §5.1 module graph intact: channels/inbox/catalogue receive `notify` as an injected callback; only apps import `makeRealtimePublisher`. Lint (module-boundaries rule) passes.
- The webhook hot path is untouched: `notify` fires in the *worker's* ingest, never inside the ≤500 ms intake.
- P8's DoD tests still pass unchanged; P9.1 adds the production half they lacked.

## Deviations / flags

1. **Bridge delivery is at-most-once** (Redis pub/sub, no ack). This matches §12.4's explicit best-effort contract — the DB is authoritative and `updatedSince` reconciles. Not a gap; stated for the record.
2. **`quota.warning` socket payload uses `level: 80|100`** — the web banner currently only re-renders plan data on Settings load; a toast consumer is frontend work.
3. **L-3 full contracts-import migration deferred** with reasoning above.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm jsonschema:check && pnpm test   # 352 tests (realtime suite needs local Redis)
pnpm vitest run apps/api/src/__tests__/phase91.test.ts              # the production-path proof alone
```
