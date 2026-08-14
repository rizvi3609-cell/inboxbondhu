# Phase 9 — Hardening, then the dashboard: report

**Status: done.** Lint clean, typecheck clean (now including `apps/web`), drift clean, **347/347 tests green (37 files)** — 21 new Phase 9 tests (6 retention purger, 7 journal drain, 5 eval canary, 8 degraded-mode/CSP/CORS — the API count nets to 347 after the readyz fixture fix below). Load test at 2× target **passed live**. Restore drill **executed end to end, passed**. Degraded-mode drill **run live against a killed mongod**. Next.js 15 dashboard **built, booted, and driven by curl through its own proxy against the real API**.

## Hardening (§14, §15, §16) — what was built and proven

### 1. §8.1 items 2/3/6 — the middleware chain is now complete
- **`securityHeaders()`** (`apps/api/src/middleware/security.ts`): helmet defaults + **per-request CSP nonce** (ADR-012: `'nonce-{r}' 'strict-dynamic'`, stricter than the PRD's literal `script-src 'self'` which breaks Next.js), HSTS 2y+preload, Referrer-Policy, Permissions-Policy, `frame-ancestors 'none'`. Nonce proven fresh per request. **The webhook mount stays ABOVE this stack** — its ≤500 ms path gains zero middleware (test asserts no CSP header on `/webhooks/meta`).
- **`cors(APP_URL)`**: one allowed origin, credentials, `Vary: Origin`, 204 preflight carrying exactly `X-CSRF-Token, If-Match, Idempotency-Key, Content-Type, X-Request-Id`. Foreign origins get **no** CORS headers. Deliberately hand-rolled (~30 lines) rather than the `cors` package — one origin, no wildcard logic needed.
- **`degradedMode()`**: mongoose `readyState` probe (zero I/O on the request path). Mongo down ⇒ every route below answers `503 DEGRADED_MODE` in ~1–2 ms instead of stalling 5 s in server selection. `/healthz` now reports `degraded: true` per §14.1 row 2.

**Live drill (real killed mongod, not a mock):** webhook → `200` in 13 ms (buffered to Redis); `/healthz` → `200 {degraded:true}`; `/api/v1/me` → `503 DEGRADED_MODE` in **1.7 ms**; mongod restarted → `readyz 200`, `me 401` (normal middleware resumed), buffered event **drained into webhookEvents** (`drained:1`).

### 2. Journal drain — the D22 file half of `webhookBufferDrainer`
`drainJournal()` in `webhookIntake.ts`, wired into the worker's 30 s drainer alongside the Redis half. Resumable (`.draining` atomic claim per file; mid-file Mongo failure rewrites only the unprocessed tail), idempotent (I48 → `deduped`), corrupt lines counted and skipped, `maxLines` budget per pass, missing dir = clean no-op. 7 tests including replay-exactly-once and budget-resume.

### 3. `retentionPurger` body (P-11) — `packages/core/src/db/retentionPurge.ts`
- Whole-workspace cascade in the **exact §12.11 phase order** (messages→…→memberships→workspace-doc-LAST) so no intermediate crash leaves a dangling reference; `orderCounters` deliberately survive (§5.1: permanent).
- Row-level retention in live workspaces: conversations+messages (90 d), orders+reservations (90 d), **customer anonymisation** (`Deleted Customer #hash`, phone/address/notes nulled, **`phoneHash` survives** — asserted), imports 30 d, usageLedger 13 mo, users (pending_deletion +90 d, only when they own no workspace).
- **P-11 test:** crash injected mid-cascade → mid-state has no orphans → re-run finishes → third run deletes nothing. `maxBatches` bound proven to resume next day without purging the parent early.
- All queries run under `skipTenancy` with the allowlisted `retentionPurger` caller (§5.4 bypass #1 finally exercised for real).
- Wired at **03:00 Dhaka** via a minute-tick scheduler: once-per-Dhaka-day Redis marker + the §13.2 job lock (single-flight preserved across two workers).

### 4. `evalCanary` body (P-10) — `packages/core/src/modules/ai/canary.ts`
Deterministic 20-case subset (`pickCanarySubset` — id-sorted, stride-picked, input-order independent), run through the SAME assemble→complete→parse→ground path as the pipeline against the production `PROMPT_VERSION`. Tests prove it **detects** three regression classes: fabricated sourceIds (grounding block), parse failures, missed injections. Wired at **04:00 Dhaka**; any failure logs `ALERT ai.canary_failed`.

### 5. Load test at 2× target — `tools/loadTest.ts`, **run live**
2× the CON-05 modelled peak (8 rps steady + 16-wide bursts, 20 s): **192 requests, 0 non-200, webhook p50 26 ms / p95 108 ms / p99 122 ms** (gate: p95 < 500 ms), `/healthz` p95 44 ms. CI-friendly exit codes.

### 6. Restore drill — `tools/restoreDrill.ts`, **executed once end to end (§19)**
Dumped all **19 collections** (canonical EJSON — full BSON fidelity) + index definitions, restored into a scratch DB starting from `dropDatabase()`, indexes recreated first (proves uniques accept the data), verified per-collection counts + canonical-EJSON content hashes + a business invariant on the restored rows (every order's `subtotalMinor == Σ lineTotalMinor`). **PASSED** against the live seeded DB (263 docs including 192 load-test webhook events).

### 7. On-call runbook — `docs/RUNBOOK.md`
Symptom-first pages for: Mongo down, Redis down (P-02, incl. the noeviction re-assert), oversell SEV1, tenant-scope-violation SEV1, DLQ depth, AI paused/handover spikes, socket storms (P-08), webhook latency, restore/DR, load test. Severity ladder + daily/weekly checks matching the §15.5 alert names the code emits.

### 8. Config hardening
`TICKET_SECRET` (dedicated realtime ticket secret, falls back to `JWT_SECRET` when empty — flag #7 from Phase 8 closed) and `JOURNAL_DIR` (D22 path, was hard-coded in the bootstrap) joined `packages/config` + `.env.example`.

## The dashboard — Next.js 15 App Router (`apps/web`)

Against the now-frozen API contract, **no backend changes needed for it** (the contract held):

- **Architecture:** all browser traffic uses **relative URLs**; `next.config.ts` rewrites `/api/*`, `/realtime`, `/healthz` to the api origin. Cookies stay first-party (SameSite=Strict survives), CORS stays single-origin, and the preview/proxy environment works unchanged. The ONE web-side `process.env` read (`API_ORIGIN`, build-time, next.config) carries an eslint-disable with justification — `packages/config` cannot ship to a browser bundle.
- **`src/middleware.ts`:** per-request CSP nonce (ADR-012), session-presence redirect to `/login?next=…`, security headers. Verified live: CSP present on pages, absent on proxied API routes, `/w/*` without a cookie 307-redirects.
- **`lib/api-client.ts`:** typed fetch speaking the §6.2 envelopes — CSRF mirror header on mutations, `If-Match` versions, `Idempotency-Key` (crypto.randomUUID) on replies, one transparent refresh on 401, `VERSION_CONFLICT` surfaced with reload-and-retell UX.
- **`lib/socket.ts`:** §12 handshake exactly — 60 s ticket via `#24` (access token never on the WS), fresh ticket per reconnect attempt, exponential backoff + jitter (P-08), `join:workspace` ack, `session.revoked` hard-disconnect, and **`updatedSince` reconciliation on reconnect** (one cheap query, never a refetch storm).
- **Pages:** login / register (T4 shape with `storeName`; "check your email" state — 201 no session honoured) / forgot (existence never leaked) / unlock (OTP ladder) / workspaces picker / **inbox list** (updatedSince merges, live socket updates, status filters, unread + AI/human badges) / **conversation thread** (take-over ↔ return-to-AI with OCC, resolve/reopen, idempotent reply, WINDOW_EXPIRED explained to the agent, per-message retry hidden for `WINDOW_EXPIRED` per P-01) / **orders** (confirm/cancel with If-Match, 422 oversell surfaced clearly per DF-02) / **catalogue** (CSV import with progress polling + socket, archive) / **knowledge** (draft→approve flow with the "AI can only say approved things" copy) / **analytics** (PRD §1.5 primary metric first, Dhaka-day bar series) / **settings** (channels connect/disconnect, AI config PATCHes with If-Match, plan/usage with the quota-pause banner). Global **degraded-mode banner** polls `/healthz`.
- **Proven live:** `next build` clean; production server booted; register→verify→login→workspaces→#25→#40→#24 ticket→#66 analytics→#54 knowledge-create-with-CSRF all driven by curl **through the dashboard's own proxy** (port 3000), all 200s. Contract mismatches found this way (register `storeName`, workspaces list shape, create-workspace auto-slug) were fixed **in the dashboard** — the API stayed frozen.

## Cross-phase alignment (the "everything must sync" check)

- The §8.1 chain is finally complete: items 2/3/6 slotted in WITHOUT touching the webhook mount ordering from Phase 3 or the auth/csrf/tenant chain from Phase 2 (phase2/phase4/phase8 suites untouched and green).
- `drainJournal` reuses Phase 3's `WebhookEvent` insert + I48 dedupe semantics verbatim — the Redis and file halves are provably interchangeable.
- The retention purger honours Phase 1's tenancy plugin via its own allowlisted bypass; Phase 2's `purgeAfter` setters (T2, deactivations) now actually lead somewhere.
- The canary consumes Phase 6's schema/prompt/grounding modules unmodified — no fork of the pipeline logic.
- One behavioural fix rippled backwards: `healthCheck` now short-circuits on `readyState` and caps pings at 2 s (readyz must 503 in ms, §14.1 row 3). The Phase 0 readyz test fixture gained a `readyState` field to model a connected driver — the assertion set is unchanged.
- One Phase 8 bug found by the live boot: the Socket.IO Redis adapter psubscribes before its duplicated connections finish handshaking — duplicates now enable the offline queue (the boot client keeps failing fast per INV-11).

## Deviations / flags — stated plainly

1. **No `purgeJobs` progress collection.** architecture.md §12.11 sketches one; prompt.md §5.1 fixes the inventory at exactly 19 collections. Narrow resolution: resumability by construction (phase order + idempotent `_id`-ordered batches) — the P-11 interrupt/re-run test passes without it. `// OPEN QUESTION` in `retentionPurge.ts`.
2. **User-purge cascade is under-specified.** No spec section details it. Narrow behaviour: only `pending_deletion` users owning zero workspaces are purged (sessions → memberships → user doc); owners must transfer or let the workspace purge first. Flagged in code.
3. **Canary tenant is "first active workspace".** The spec never names which tenant the daily canary runs against; a dedicated synthetic workspace is the right P10 answer. `// OPEN QUESTION` at the wiring site.
4. **The daily scheduler is a minute-tick loop, not cron syntax** — same semantics (03:00/04:00 Dhaka, once per day via a Redis `NX` day-marker + the §13.2 lock), no cron dependency added. The Dhaka-hour maths reuses the Phase 0 `DhakaTime` kernel.
5. **Web CSP allows `ws://localhost:*` in connect-src** for local dev; production stays `wss://*.inboxbondhu.me`. The api-side CSP does not carry the localhost exception.
6. **Restore drill dumps via EJSON, not mongodump** — no mongo tools binary in this environment. The drill's value (restore choreography + integrity verification) is tool-agnostic; the runbook documents both. Production keeps DO snapshots+PITR as the actual backup.
7. **`GET /invitations/:token/accept`'s email-verified gate, RBAC matrix, 18-code reachability etc.** were Phase 2–8 work and were NOT re-audited line-by-line here; §19's "all 76 endpoints" stands as of Phase 8 (75 implemented + #65 deliberately 501).
8. **Dashboard has no automated browser tests** — it is typechecked, production-built in CI (`build:web` step added), and its API integration was proven by driving every major route through the running proxy. Playwright is post-MVP.
9. **Still mock:** Meta client, LLM client, Resend, Spaces (unchanged one-file swaps — blocked on credentials). MVP gates #5 and the AI half of #6 remain blocked on Meta/LLM credentials, as reported since Phase 3.

## §19 checklist position after Phase 9

| Item | State |
|---|---|
| Nine MVP gates in CI | 1,2,3,4,7,8,9 ✅ · 5 blocked on Meta creds · 6 partial (draft-capture merge loop still open) |
| 76 endpoints or deliberate 501 | ✅ (65 = 501) |
| 18 codes reachable, 428 ≠ 400/409 | ✅ (tested through P2–P8; DEGRADED_MODE now reachable live) |
| 50 indexes, 4 global | ✅ (asserted at boot) |
| 4 transactions only | ✅ |
| 9 sweepers single-flight | ✅ — all bodies now real |
| Restore drill once | ✅ **executed this phase** |
| No any/ts-ignore/process.env | ✅ (lint-enforced; 1 documented next.config exception) |
| OpenAPI matches api-spec.md | ❌ — **api-spec.md was never uploaded**; generation without the reference would be drift-checking against nothing. Flagged since Phase 0. |

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm jsonschema:check && pnpm test   # 347 tests
pnpm build:web                                                      # dashboard production build
# live drills (need local RS + redis + booted api):
pnpm tsx tools/loadTest.ts http://127.0.0.1:4000 "$META_APP_SECRET" 20
pnpm tsx tools/restoreDrill.ts
```
