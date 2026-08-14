# Phase 0 — Walking skeleton: report

**Status: DoD passed.** Built *after* Phase 1 (out of spec order, at the user's request), with explicit alignment retrofits so the two phases form one consistent codebase. Lint clean, typecheck clean, **142/142 tests green (15 files)** — run, not assumed.

## The DoD, item by item — each demonstrated live in the sandbox

| DoD item | Evidence |
|---|---|
| api + worker start | Both booted against a real single-node Mongo replica set + Redis. API: `{"level":"info","app":"api","port":4000,"msg":"api listening"}`. Worker: all nine queues registered. |
| `/readyz` returns 200 | `curl /readyz` → `{"data":{"status":"ready","mongo":true,"redis":true}}`; `/healthz` → version + uptime. 503 `DEGRADED_MODE` paths covered by supertest. |
| Missing env var kills boot with one clear line | Live run without `MONGODB_URI`: `FATAL config: MONGODB_URI — Required (…)`, exit code 1. Also unit-tested. |
| Transaction-capable Mongo via compose | `docker-compose.dev.yml` runs mongo7 `--replSet rs0` with a one-shot `rs.initiate` container, Redis (`noeviction`, AOF), mongo-express, redis-commander. (No Docker daemon in this sandbox — compose file is spec-complete but **not executed here**; the equivalent topology was proven with a raw mongod replica set.) |
| Graceful shutdown | SIGTERM to the api → `shutdown: draining` → `shutdown: complete`, port 4000 released. Worker drains BullMQ workers (waits for in-flight jobs) then queues, then connections. |
| CI: lint → typecheck → test → build | `.github/workflows/ci.yml` with a Redis 7 service, the §5.7 `$jsonSchema` drift gate, and the §15.4 PII log scan (greps BD-phone-shaped strings in test output). |

## What was built

- **`packages/config`** — the ONLY place that reads `process.env` (enforced by our own lint rule, which caught my own violation in `apps/api` during development). Full §4 env schema in Zod: coercion, `JWT_SECRET ≥ 32`, `CHANNEL_TOKEN_MASTER_KEY` = exactly 32 bytes base64, `REDIS_MAXMEMORY_POLICY` literal `noeviction`, `MAX_DISCOUNT_PERCENT ≤ 50`. Plus `loadSeedConfig()` so the seed script needs only `MONGODB_URI`.
- **`packages/logger`** — pino, structured single-line JSON, the §15.4 redaction list applied at 4 nesting depths (INV-12), `withRequestContext()` threading `requestId`/`workspaceId` onto every line. Tests prove phone numbers, addresses, message bodies, tokens, and cipher fields never appear.
- **All 8 kernel primitives** (6 new + the 2 from Phase 1): `money` (branded integer type, `fromTaka/toTaka/add/sub/mulQty/percentOf` — floors, property-tested across the whole 0–100 range), `deadline` (AbortController wrapper: `remaining/assertRemaining/child`, parent-abort propagation — INV-09 backbone), `result`, `ulid` (monotonic, sortable, timestamp-recoverable), `dhakaTime` (`dhakaYear`, `dhakaPeriodKey`, `startOfDhakaMonth`, `isWithinBusinessHours` incl. overnight windows; UTC+6 no-DST arithmetic), `eventBus` (handler-isolation so one bad subscriber can't break emit).
- **`db/client.ts`** — the §4 boot chain in order: Mongo → Redis → `CONFIG GET maxmemory-policy` (**live-tested against a real allkeys-lru Redis: boot refuses with one clear line**) → index assertion. `healthCheck()` for `/readyz`.
- **`apps/api`** — thin Express 5 bootstrap: `/healthz`, `/readyz`, graceful SIGTERM drain with a 10 s hard stop. No business logic.
- **`apps/worker`** — the nine §13.1 queues with exact concurrency/attempts/backoff (conversation-ai = 3, csv-import = 1, email ladder 30s/2m/10m — all asserted by test), empty no-op processors, `JobEnvelope` typed with `workspaceId` + `requestId`, graceful drain. **Sweeper lock scaffold** (`SET lock:<job> <id> NX PX <ttl>`, holder-checked Lua release) written now as §13.2 instructs — proven against real Redis: two concurrent runs → exactly one executes.
- **ESLint 9 flat config + two custom rules**: `module-boundaries` (the §5.1 graph incl. "MOD-10/11/12 never imported by domain modules") and `no-missing-tenant-filter` (lint-time complement to the runtime tenancy plugin).
- **`apps/web`** — placeholder only, per guardrail #1.
- **Turborepo config, `.env.example`, CI workflow.**

## Cross-phase alignment (your requirement) — what was retrofitted

1. **`Order.recalculate()` now calls `Money.mulQty`/`Money.floorPercent`/`Money.add`/`Money.sub`** instead of inline arithmetic. All Phase 1 money tests still pass unchanged — proving the two implementations agree.
2. **The seed script's `// OPEN QUESTION` about direct `process.env` access is resolved** — it now imports `loadSeedConfig()` from `@inboxbondhu/config`.
3. **`assertIndexes()`/`createIndexes()` from Phase 1 are now wired into the real boot sequence** (`bootDataLayer`), and the boot was demonstrated creating all 19 collections + indexes on a live replica set (verified: `conversations` shows I24, I25, I26, I27, I27b).
4. **The kernel `AppError`/`TenantContext` from Phase 1 are unchanged** — Deadline reuses `AppError('UPSTREAM_FAILED')`, keeping one error taxonomy.
5. **Contracts and models untouched** — no drift introduced; the `$jsonSchema` check still passes byte-for-byte.

## Deviations / notes — stated plainly

- **Order of phases**: Phase 1 was built first (your instruction), Phase 0 second. The spec's reason for the ordering (never stub twice) was respected in effect — nothing from Phase 1 was rebuilt, only wired in.
- **Docker compose not executed here** — the sandbox has no Docker daemon. Verified instead with the same topology assembled manually (raw mongod `--replSet rs0` + `rs.initiate` + real Redis with both `noeviction` and a deliberately bad `allkeys-lru` instance). Run `docker compose -f infra/docker/docker-compose.dev.yml up` on your machine to confirm locally.
- **`turbo` binary present but scripts call tools directly** — turbo's cache adds value once builds get slower; the task graph is configured (`turbo.json`) and `pnpm dev` routes through it.
- **Version string in `apps/api` is a constant** (`0.1.0`) rather than an env/`npm_package_version` read — our own lint rule forbids `process.env` outside config; wiring a build-stamped version belongs to the deploy pipeline (Phase 9).
- **Redis-dependent tests skip politely when no Redis is present** but assert they actually ran when `CI=true` — a silent skip cannot pass the CI gate (agent.md §10's "a test that passes because it silently skipped is worse than no test").
- **PII log scan is a pragmatic grep** for BD-phone-shaped strings in test output; the full "PII detection scripts" (PRD §4.1) can grow in Phase 9 hardening.

## Not done (later phases, deliberately)

- No routes beyond `/healthz`/`/readyz`, no auth, no middleware chain (`requestId`/`tenant`/`rbac`/`csrf` are Phase 2+).
- No real queue processors — all nine are no-ops until Phases 3–8.
- No cron sweepers — only their lock scaffold, as §13.2 requires at Phase 0.
- No `packages/integrations` (meta/llm/email/storage) — first needed in Phase 3.
- No Dockerfiles/PM2/nginx configs — deploy artefacts, Phase 9.

## How to run

```bash
pnpm install
docker compose -f infra/docker/docker-compose.dev.yml up -d   # Mongo RS + Redis + UIs
cp .env.example .env                                          # then edit secrets
pnpm lint && pnpm typecheck && pnpm test                      # all gates
pnpm --filter @inboxbondhu/api start                          # api on :4000
pnpm --filter @inboxbondhu/worker start                       # worker, 9 queues
curl localhost:4000/healthz && curl localhost:4000/readyz
```
