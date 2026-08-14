# Phase 1 — Data layer: report

**Status: DoD passed.** `tsc` clean on both packages, 74/74 tests green (7 files), all runs verified — not assumed.

```
Test Files  7 passed (7)
Tests       74 passed (74)
```

## What was built

### `packages/contracts` — Zod schemas (source of truth)
One file per domain (`identity`, `workspace`, `channels`, `inbox`, `catalogue`, `knowledge`, `orders`, `ops`), all 19 collection document schemas, types via `z.infer` only. Deliberate asymmetries preserved and commented:
- `knowledgeItems.answer` ≤ 2000 in the DB schema, with a separate `KnowledgeItemAnswerApi` (≤ 500) export for the Phase 5 API edge.
- `variants[].sku` vs `orders.items[].variantSku` — both names kept.

### `packages/core/src/db` — models, plugins, helpers
- **All 19 Mongoose models** with the exact field specs from `prompt.md` §5.2 / `database.md` §2, `strict: 'throw'`, trap notes in comments.
- **`plugins/tenancy.ts`** — tests written first. Guards the 11 query ops + `aggregate`; missing `workspaceId` filter **throws** `TenantScopeViolationError` and emits the `tenant.scope_violation` signal (hook exposed for Datadog/SEV1 wiring in Phase 8). Exempt: `users`, `sessions`, `webhookEvents`. Exactly four `skipTenancy` bypasses, each requiring a declared caller and logged.
- **`plugins/occ.ts`** — `version` on save + auto `$inc` on update ops; `occFilter()` + `throwVersionConflict()` producing `VERSION_CONFLICT` with `currentVersion` and `conflictingFields` (the only extended error envelope). `messages` has **no** version field (gotcha #9) — asserted by test.
- **`plugins/money.ts`** — every `*Minor` path (including embedded arrays) rejects non-integers at the model layer.
- **Indexes** — all catalogue indexes named I01…I59, created idempotently via `createIndexes()`, asserted by `assertIndexes()` (boot gate), TTLs where specified, **no TTL on `stockReservations`** (DB-07, tested). `auditGlobalIndexes()` enforces the global-unique allowlist.
- **`$jsonSchema` generated from Zod** (`jsonSchema/generate.ts`), written to `generated/*.json`, `--check` drift mode for CI, applied via `collMod` (`applyValidators()`); a raw driver write with `discountPercent: 90` is rejected by the DB itself — tested.
- **`withTx()`** — single implementation, `TransientTransactionError` retry, tested for commit and rollback on the memory replica set.
- **Custom validators** for the single-document DB-unenforceable rules: `author.userId` iff `type='agent'` (both directions), `orderCode` regex, exactly-7 `businessHours.days`, variant-sku-unique-within-parent, invitation role never `owner`, `maxDiscountPercent ≤ 50`, `orderYear`/`orderCode` immutable.
- **Seed script** — 1 workspace, 1 owner, 10 products with variants, 20 approved FAQs, 5 conversations, 3 orders in different states (`Collecting`/`Confirmed`/`Delivered`), order codes from the year-scoped counter. **Runs clean twice** — tested with identical counts on the second run.

### Also proven by test (patterns later phases must copy)
- **Oversell guard shape**: 20 parallel reservations of the last unit → exactly 1 success, `reserved ≤ stock` (the `$expr` one-document pattern for T1).
- `nextOrderCode()`: atomic `$inc`, year-scoped (2027 restarts at 1), race-safe under 20 concurrent calls.
- I29 dedupe: duplicate MID collides, `null` MIDs never collide.
- I18: second workspace claiming the same page → `E11000`.
- I21: same `externalUserId` across providers does **not** merge (DB-03).
- Membership tombstone: double active membership blocked, re-invite after removal works (I12 partial).
- I48: duplicate `dedupeKey` → duplicate-key error, treated as successful dedupe in the test.

## Deviations from the letter of the spec — stated plainly

1. **I29 is partial-unique, not sparse-unique.** On a *compound* index, `sparse` skips a doc only when **all** keys are absent; `workspaceId` is always present, so two queued outbound messages (`providerMessageId: null`) would collide and break the outbound path. Implemented as `unique` + `partialFilterExpression: { providerMessageId: { $type: 'string' } }`, which matches the catalogue's stated intent ("Webhook dedupe") and `database.md` §4.1 rule 4 ("partial over sparse where the filter is known"). Same dedupe semantics, no false collisions.
2. **`handoverReason` enum values invented in shape only.** `database.md` §2.8 gives the enum in prose ("low confidence, keyword, explicit request, complaint, repeated failure"). Implemented as snake_case strings with an `// OPEN QUESTION` marker. Needs the exact wire values from `api-spec.md` (not provided in the uploads).
3. **`paymentMethod`: followed `database.md` §2.12 (`cod|bkash|nagad|rocket`)** over `architecture.md` §5.3's `'cod'|'online'`. `database.md` is the field-level authority and the precedence order puts it above... actually below `architecture.md` — but `database.md` §0.3 declares itself the aligned superset for field specs and lists the MFS enum with `paymentRef` ("MFS transaction ID"). Flagging rather than hiding it: **if `api-spec.md` says `cod|online`, this is a genuine conflict** (database.md §2.12 vs architecture.md §5.3 line ~557).
4. **`invitations {tokenHash}` (I15) is a global unique index that is *not* in §4.6's four-item allowlist.** The catalogue (§4.2) specifies it; the allowlist omits it. Created as catalogued, tracked in `CATALOGUE_GLOBAL_UNIQUES_PENDING_DECISION` in `indexes.ts` rather than silently widening the allowlist. Raise before Phase 2.
5. **Index count**: the schemas declare the catalogue's I01–I59 (59 catalogue entries; `prompt.md` §5.5 says "50 total"). I followed `database.md` §4.2, the field-level authority, which itself totals "59 indexes across 19 collections".
6. **`orderYear` mutation throws at save** (immutable + `strict:'throw'`) rather than being silently ignored — stricter than required, kept.

## Not done (deliberately — later phases)

- No `apps/api` / `apps/worker`, no Express routes, no BullMQ, no Redis, no `packages/config`/`logger` — those are Phase 0/2+ artefacts; this session is Phase 1 only per the one-phase-per-session rule. (The seed script reads `MONGODB_URI` directly with an `// OPEN QUESTION` note pending the config loader.)
- No ESLint module-boundary/tenant-filter custom rules (Phase 0 scope; the runtime tenancy plugin covers the enforcement this phase requires).
- Transactions T1–T4 themselves (Phases 2 and 7) — only `withTx()` and the guard patterns they must copy.
- `zxcvbn`/Argon2id — Phase 2. The seed owner has a placeholder hash, marked as such.
- OpenAPI generation from Zod (ADR-003) — Phase 2+ when routes exist.

## Unsure / for review

- Whether the tenancy plugin should also guard `insertMany`/`create` (spec lists 11 query ops + aggregate; writes carry `workspaceId` as a required field, so the schema enforces presence — but nothing verifies it matches the caller's context at insert time until the repository layer lands in Phase 2).
- `workspaces` is treated as tenancy-exempt at the plugin level because it is addressed by `_id` (it *is* the tenant). If you want `_id`-equals-context enforcement there too, say so and I'll add it.

## How to run

```bash
pnpm install
pnpm typecheck            # tsc, both packages
pnpm test                 # vitest, 74 tests (spins up a mongod replica set)
pnpm jsonschema:generate  # regen validators from Zod
pnpm jsonschema:check     # CI drift gate
MONGODB_URI=... pnpm seed # idempotent seed
```
