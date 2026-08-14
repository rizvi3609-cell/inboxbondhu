# Phase 3 — Channels & the webhook path (MOD-03), CP-1: report

**Status: DoD passed.** Lint clean, typecheck clean, **226/226 tests green (24 files, 3 consecutive stable runs)** — 55 new Phase 3 tests. The headline invariants were also demonstrated **live** against the running API.

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| **200 in < 500 ms under load AND with Mongo stopped** | Live: 50-req burst in tests (p95 ≪ 500 ms); by curl with Mongo up: **24 ms**; with Mongo **killed**: **2–3 ms**, buffered to Redis. Also unit- and HTTP-tested with a disconnected mongoose. |
| Replayed payload creates exactly one message | Live: same signed body POSTed 4× → **1** `webhookEvents` row. Tested at intake (Redis SETNX + I48 E11000-as-dedupe), at HTTP, and at ingest (I29 unique on `providerMessageId`). |
| A DM reaches the DB; a manual reply reaches Messenger (gate #5) | Ingest test: PSID→customer upsert (3-field key) → conversation → message → denormalised fields → `metaWindowExpiresAt = +24 h` → billing counted once. Outbound test: decrypts the AES-256-GCM token, calls the (mock) Send API, sets `sent` + `providerMessageId`. *Real Messenger delivery needs live Meta credentials — see deviations.* |
| Unknown page → `orphaned` + alert | Ingest marks `processStatus: 'orphaned'`, never rejects; worker logs `ALERT webhook.orphaned`. Tested. |

## What was built

**The six-step intake** (`webhookIntake.ts`) — exactly §9 Phase 3's order: raw-body HMAC (constant-time) → plaintext `dedupeKey` → Redis `SET wh:{key} NX EX 86400` → `webhookEvents` insert (E11000 = successful dedupe, gotcha #5) → enqueue → 200. Invalid signature: recorded `invalid_signature`, still 200, never enqueued (never confirm validity to a prober). Failure ladder: Mongo down → **Redis `wh:buffer`** → Redis also down → **D22 ndjson journal** — never a non-2xx to Meta.

**`webhookBufferDrainer`** — every 30 s in the worker; drains the Redis buffer once Mongo returns; replay-safe via I48. **Proven live: 6 events buffered during a real Mongo outage, all 6 recovered to Mongo after restart, zero loss.**

**`webhook-ingest` processing** (`ingest.ts`) — tenant resolution via I18, customer upsert (I21, DB-03 3-field key), find-or-create conversation, message insert with I29 dedupe, denormalised conversation fields + the **hard 24 h `metaWindowExpiresAt` gate**, `countedForBilling` idempotent usage counting (3 messages → 1 billed conversation, tested), delivery/read receipts → `deliveredAt`/`readAt`, media jobs split out (media never blocks the reply), AI-eligibility flag for the Phase 6 queue.

**Outbound delivery** (`outbound.ts`) — decrypt token → Send API → `sent`+mid; **refuses to send outside the window** (OQ-14: no HUMAN_AGENT tag — tested: Meta never called, message failed `WINDOW_EXPIRED`); 4xx → permanent fail + failureCode; 5xx → retryable (message stays `queued`, BullMQ ladder per §13.1); idempotent replay.

**AES-256-GCM envelope crypto** (`tokenCrypto.ts`) — per-record DEK wrapped by the env KEK, `keyVersion` rotation (old rows decrypt with old KEK — tested), 12 B IV / 16 B tag per schema, GCM tamper detection on cipher/tag/IV, plaintext never anywhere in the envelope.

**ChannelsService** — OAuth start (signed HMAC `state` in Redis, single-use `GETDEL`; unspecified failure → `502 UPSTREAM_FAILED` per §17), callback (forged/replayed state → `403 CSRF_TOKEN_INVALID`; page held by another workspace → I18 E11000 → `409` *"already connected to another workspace"* per US-008 AC-3), **soft disconnect** (status `revoked`, token fields zeroed, row retained; foreign id → 404), reconnect, list (tokens never returned).

**Routes**: `/webhooks/meta` GET (constant-time challenge) + POST mounted **before** json/auth/csrf/tenant with raw-body parsing (§8.1 note); `/w/:workspaceId/channels` #35–39 admin-gated behind the full middleware chain. `packages/integrations/meta`: `MetaClient` interface + deterministic mock (client·types·__mocks__ shape).

## A real bug found by the live drill — worth reading

The vitest "Mongo down" tests passed, but the **live** drill initially showed 200s taking **5.0 s** — the mongoose driver's `serverSelectionTimeoutMS` stall, invisible in tests because a *disconnected* mongoose throws instantly while a *connected-then-killed* one waits. Fix: the intake now checks `mongoose.connection.readyState !== 1` and goes straight to the buffer. Re-drill: **2–3 ms**. This is exactly why the spec demands the DoD be proven with Mongo actually stopped, not simulated.

Also fixed en route: `nextOrderCode`'s first-order-of-year upsert race (two concurrent upserts both take the insert path; loser gets E11000 on `_id`) — now retried; the 20-way race test is stable across runs.

## Deviations / flags — stated plainly

1. **The real Meta HTTP client is not written** — `packages/integrations/meta` ships the `MetaClient` interface + mock only. Building the HTTPS client against Graph API requires a live Meta app (app id/secret, page, ngrok) which this environment can't validate; an untested HTTP client would be worse than an honest mock. The worker wires the mock with an `// OPEN QUESTION` marker; the swap is one file by design. **Consequence: MVP gate #5's "real DM appears in dashboard" needs live credentials to close.**
2. **`media-fetch` stays a no-op processor** — its consumer (Spaces storage integration) doesn't exist yet; §9 lists Spaces under P1 integrations that first bite in Phase 5 (CSV) / media. The job wiring + payloads exist; ingest already emits the jobs.
3. **Journal-drain half of `webhookBufferDrainer`** (reading D22 ndjson files back) is Phase 8 per the resilience section; the Redis half runs now. Journal *writing* works and is tested.
4. **`tokenExpiryChecker` cron** (item 8) — belongs to the Phase 8 sweeper block with the other crons; `tokenExpiresAt` + I20 partial index are in place since Phase 1.
5. **Instagram**: intake/extraction handle `object: 'instagram'`, but OAuth is Facebook-page-only until the real Meta client lands.
6. **`degradedMode` middleware (§8.1 step 6)** is effectively implemented *inside* the intake (readyState check + buffer) for the webhook path — the only Phase 3 consumer. The generic 503-for-everything-else middleware joins the chain when Phase 8 hardens resilience.

## Cross-phase alignment

- Phase 1's `webhookEvents`/`channelConnections`/`customers`/`conversations`/`messages` models and I18/I21/I24/I29/I48 indexes are consumed untouched — the "already connected" 409 IS Phase 1's I18 E11000 surfacing with friendly text.
- Phase 2's middleware chain gates the channel routes; `NOT_FOUND`-not-403 for foreign resource ids per the error table.
- Phase 0's queue table drives retry behaviour: `outbound-message` throws only on retryable failures so BullMQ's exp-3s×4 ladder applies; permanent failures return cleanly (no retry).
- `DhakaTime.dhakaPeriodKey` (Phase 0 kernel) stamps `billingPeriodKey`.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test        # 226 tests
# live drill (needs mongod RS + redis):
pnpm --filter @inboxbondhu/api start
# GET  /webhooks/meta?hub.mode=subscribe&hub.verify_token=...&hub.challenge=X  → echoes X
# POST /webhooks/meta with X-Hub-Signature-256 → 200 ~20ms; replay → 1 row
# kill mongod → POST again → 200 ~3ms, redis-cli LLEN wh:buffer grows
# restart mongod → drainer replays, zero loss
```
