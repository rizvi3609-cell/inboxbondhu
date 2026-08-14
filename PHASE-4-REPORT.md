# Phase 4 — Inbox (MOD-04): report

**Status: DoD passed.** Lint clean, typecheck clean, **242/242 tests green (26 files)** — 16 new Phase 4 tests (11 service + 5 HTTP).

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| Inbox list p95 < 200 ms on seeded volume | HTTP test: 500 seeded conversations, 20 sequential authenticated requests through the full middleware chain → p95 < 200 ms, each page exactly 20 rows sorted `lastMessageAt: -1` (I24). |
| Same `Idempotency-Key` twice → one message + 200 replay | Service + HTTP: first call 201, replay **200** (never 201, never an error) with the **original** messageId; exactly 1 message in the DB, exactly 1 outbound job enqueued. Missing key → **428** `PRECONDITION_REQUIRED`. |
| Taking over stops AI | `PATCH mode: human` sets `handoverReason: explicit_request`; **a human reply also forces `mode: human`** (item 5) — both tested. Return-to-AI clears the reason. |
| Killed worker → sweeper marks failed within 90 s | `sweepStuckMessages(60)`: a queued message backdated 2 min → `failed`/`STUCK_TIMEOUT`; a fresh queued message untouched. Runs every 30 s under the Redis job lock in the worker (60 s threshold + 30 s cadence ⇒ ≤ 90 s worst case). |

## What was built

**`InboxService`** (`packages/core/src/modules/inbox/`):
- **#40 list** — filters `status/mode/assignedTo/channelId/q/updatedSince`, cursor pagination on `lastMessageAt`, **default limit 20** (gotcha #8 — every other list defaults 25), one batched customer lookup (no N+1 against the 600k messages collection). `updatedSince` built now for §12.4 socket-reconnect reconciliation, as instructed.
- **#41 get** — conversation + customer + open-order summary (`Collecting/AwaitingConfirmation/Confirmed/Processing`). **Viewer PII gating**: `phone`/`addressText` nulled for viewers per the §8.7 matrix.
- **#43 messages** — cursor ascending on I28; **agent open clears `unreadCount`, viewer read does not** (a viewer can't act on the thread, so it shouldn't eat the badge).
- **#42 update** — OCC via `version` filter (409 carries `currentVersion` + `conflictingFields`); take-over / return-to-AI / assign / resolve, each audited with the role held at the time. **Return-to-AI is refused (`422`) while an order sits in `Collecting`/`AwaitingConfirmation`** — cancel/finish first, then allowed (tested both sides).
- **#44 sendMessage** — Idempotency-Key claim/finalise (Redis `SET NX` in prod, in-memory in tests); concurrent same-key requests get `409 DUPLICATE_RESOURCE` rather than a double-send; message inserted `queued` with `author.type: 'agent'` + `userId`; conversation denormalised fields updated; outbound-message enqueued. The Phase 3 outbound worker then enforces the 24 h window on actual delivery.
- **#45 retry** — failed outbound only (`INVALID_STATE_TRANSITION` otherwise); **`WINDOW_EXPIRED` refuses retry with a clear message** — requeueing cannot reopen Meta's window, so pretending otherwise would just burn a retry cycle and confuse the agent.
- **`sweepStuckMessages`** — cross-tenant sweep on the I30 partial index under `skipTenancy` (documented bypass), wired into the worker every 30 s with the Phase 0 job lock.

**Routes** #40–45 mounted under the full auth+csrf+tenant chain; messagesRouter at `/w/:id/messages` for retry. Zod contracts in `packages/contracts/src/inboxApi.ts`.

## Deviations / flags — stated plainly

1. **Idempotency replay storage is Redis (24 h TTL), not Mongo.** None of the 19 collections stores replay bodies, so Redis is the narrowest home. Consequence flagged in code: if Redis lost the key inside a client's retry window, a duplicate outbound would be possible — Redis runs `noeviction` (INV-11) so this requires an actual flush, but it is technically "Redis as the only copy" for the replay marker (INV-11 tension). `// OPEN QUESTION` marker in the service; if `api-spec.md` shows an `idempotencyKeys` collection, it's a one-file swap.
2. **Replay returns `{messageId, replayed: true}` rather than a byte-identical original body.** The spec says "200 with the original body"; the original body here IS `{messageId}` — same id, same shape — but I did not persist full response snapshots. Same one-file swap if the api-spec demands byte-level replay.
3. **Socket emissions (`message.created`, Failed-Jobs surfacing) are Phase 8** — §12.4's rule is satisfied the right way around: every state change lives in the DB now; sockets will only ever be a notification layer on top. `updatedSince` already gives clients the reconciliation path.
4. **`q` search** hits `lastMessagePreview` with an escaped regex — the narrow interpretation. Full-text over message bodies would need a new index on the 600k-doc collection (four-index budget, gotcha: "do not add a fifth").
5. **Take-over sets `handoverReason: 'explicit_request'`** — reusing the Phase 1 enum's nearest value (the enum's exact wire values are still the Phase 1 OPEN QUESTION pending `api-spec.md`).

## Cross-phase alignment

- The list runs on Phase 1's I24 exactly as designed; threads on I28; the sweep on I30's partial index.
- #44 feeds Phase 3's `outbound-message` worker — which already refuses out-of-window sends, so the whole reply path composes: HTTP → queued → worker → window check → Send API → receipts (Phase 3 ingest) update `deliveredAt/readAt`.
- The If-Match/Idempotency-Key error discipline matches Phase 2's workspace PATCH exactly (`428` missing vs `409` stale — never conflated).
- Cross-tenant 403 and foreign-id-404 re-verified on every new route.

## Not done (deliberately)

- Away-message logic (P-09, once-per-customer-per-day) — that's an **AI-pipeline** behaviour (§10.5 trigger 10), Phase 6.
- Socket gateway/rooms/tickets — Phase 8, with `session.revoked` emission and Failed Jobs UI surfacing.
- `GET /jobs/failed` listing — Phase 8 (§13.3 DLQ block).

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test   # 242 tests
# then: register/login, seed conversations, and walk #40–45 by curl —
# 428 without Idempotency-Key, 201→200 replay with it, 428/409 on If-Match.
```
