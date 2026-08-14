# Phase 2 — Identity & Workspace (MOD-01, MOD-02): report

**Status: DoD passed.** Lint clean, typecheck clean, **182/182 tests green (19 files)** — 40 new Phase 2 tests (28 service + 12 HTTP integration). Every DoD item also demonstrated **live by curl** against the real API on a real replica set.

## DoD, item by item

| DoD item | Evidence |
|---|---|
| Full register → verify → login → refresh → logout by curl | Live: 201 no-session → 401 "Email not verified" (distinct message) → 200 + 3 cookies (`ib_at` Path=/, `ib_rt` Path=/api/v1/auth, `ib_csrf`) → refresh 200 (rotated) → logout 200 → next call 401 `SESSION_REVOKED`. Also as a supertest. |
| 15 bad logins → 423, OTP unlock recovers | Service test walks the full 5→1 min / 10→15 min / 15→indefinite ladder; OTP unlock clears `lockedUntil` AND resets the counter; wrong OTP rejected. |
| 6th login evicts the LRU; evicted device gets 401 SESSION_REVOKED | Test makes the oldest-created session the most recently *used* — the eviction correctly takes the second-created (true LRU by `lastUsedAt`, not `createdAt`), exactly 5 active after, evicted reason `evicted`. |
| Token reuse kills the family | Replaying a rotated-out refresh token revokes the ENTIRE `familyId` including the newest legitimate session (`reuse_detected`), returns 401 `SESSION_REVOKED`. Proven at service and HTTP level. |
| Removing a member unassigns conversations + kills sessions in one transaction | T2 test: tombstone + unassign→pending + `member_removed` revocation + outbox + audit (`actorRole` snapshotted) all verified, cache invalidated synchronously, re-invite works. HTTP test: removed member's next request → 401. |
| **Cross-tenant → 403 on every workspace route (MVP gate #8)** | Integration test iterates all 10 workspace routes with a foreign member → every one 403 `WORKSPACE_FORBIDDEN`. Nonexistent workspaceId also 403 (no existence leak). Demonstrated live by curl too. |

## What was built

**`packages/contracts`**: `auth.ts` (password policy ≥10 + upper/lower/digit, register/login/verify/reset/OTP bodies, store name `< > &` block), `workspaceApi.ts` (workspace/member/invitation/transfer bodies — invitation role can never be `owner` at the type level).

**MOD-01 identity** (`packages/core/src/modules/identity/`):
- `crypto.ts` — Argon2id (m=19456,t=2,p=1), zxcvbn ≥ 3 + common-password blocklist, SHA-256 token hashing, HS256 JWT with `sub/sid/gen` and **no role/workspaceId in the token** (verified by test), previous-secret rotation overlap.
- `service.ts` — T4 registration (user + workspace + owner membership + outbox `email.verification` in ONE transaction; slug suffix on collision; 201 with **no session**), verify-email (24 h expiry, hash-matched), login (cumulative ladder, **`failedLoginCount` never reset by success** — tested), atomic LRU eviction via single `findOneAndUpdate` sorted `lastUsedAt: 1`, refresh rotation (insert new row gen+1, mark old `rotated` — never in place), family revocation on reuse, logout/logout-all, forgot/reset (generic anti-enumeration response, single-use token, global session revocation, counter reset), OTP unlock, deactivate (password re-auth, `purgeAfter` +90 d).
- `repository.ts` — the ONE `.select('+passwordHash')` gateway (gotcha #2).

**MOD-02 workspace** (`packages/core/src/modules/workspace/`):
- T2 five-step removal cascade in one `withTx`, with the owner-guard and admin-cannot-remove-admin rules; **synchronous** membership-cache invalidation injected as a dependency (Redis-wired in the app, spy-verified in tests).
- T3 ownership transfer: password re-auth via the repository, atomic role swap + `ownerId` update, audits both sides, exactly-one-owner asserted after.
- Invitations: 7-day token (only hash stored), max-20 `countDocuments` guard, duplicate/already-member 409s, accept requires **verified email**, wrong-email rejection, single-use.
- Workspace create (slug suffix), listForUser (switcher), deactivate (owner-only, +90 d).

**`apps/api`** — §8.1 middleware slice: `requestId` → `auth` (JWT verify + session `revokedAt` check every request + `lastUsedAt` refresh) → `csrf` (Synchronizer Token) → `tenant` (membership → TenantContext, 60 s Redis cache, **403 WORKSPACE_FORBIDDEN, never 404**) → `rbac(minRole)` → `validate(zod)` → thin handler → `errorHandler` (canonical envelope; `VERSION_CONFLICT` is the only extension; unknown errors never leak a stack). Rate limits per §8.5 (fail-open on Redis death, per P-02). Routes #5–23 and #25–34 implemented.

## Deviations / flags — stated plainly

1. **T2 session-revocation scope**: §9 says "revoke all their sessions **for that workspace**", but sessions are user-scoped with no `workspaceId` field (D02) — a per-workspace revocation is structurally impossible. Implemented: revoke ALL the member's sessions, matching PRD §2.1 step 3 and the MVP gate wording. `// OPEN QUESTION` in the code.
2. **Verification/reset tokens ride on `outboxEvents`** (payload carries the SHA-256; matching is by hash) rather than a dedicated `verificationTokens` collection — the 19-collection inventory has no such collection, and D01 only reserves fields for the unlock OTP. Narrowest implementation that satisfies "hash stored, 24 h/1 h expiry, single-use". If `api-spec.md` shows a different storage shape, this is one file to change.
3. **`security_notifications` emails** (password change, new device, role change — PRD §2.1) are outbox events only; the email *sender* is the Phase 8 notifications worker. Events are written now so nothing is stubbed twice.
4. **Rate limits are fixed-window** (`INCR`+`EXPIRE`), not sliding — meets §8.5's stated limits; refine if api-spec demands sliding windows.
5. **`GET /realtime/ticket` (#24) not implemented** — it belongs to the Phase 8 Socket.IO gateway; implementing a signed ticket with no socket gateway to consume it would be a stub.
6. **Register response carries no verification token** (it travels only via outbox→email). The curl demo marks the user verified via direct DB write to simulate the email click; the `/verify-email` endpoint itself is exercised in the vitest cycle via the service.

## Not done (later phases, deliberately)

- helmet/CSP, CORS, degradedMode middleware (§8.1 steps 2/3/6) — Phase 3 hardens the chain when the webhook path (which depends on degraded mode) lands.
- Channels routes #35–39 — Phase 3 (Meta OAuth + AES-256-GCM).
- Email sending (Resend integration), socket `session.revoked` emission — Phase 8; the outbox events exist now.
- Audit-log query UI/API — Phase 8/9.

## Cross-phase alignment

- Reuses Phase 1's models/plugins untouched; Phase 0's `AppError` codes map 1:1 to the §6.3 table in `errorHandler`.
- `occFilter`/`throwVersionConflict` from Phase 1 now serve the live `PATCH /w/:id` If-Match flow (428/409 discipline proven by curl).
- The tenancy plugin's `skipTenancy` allowlist is exercised legitimately in exactly three places (invitation token lookup, outbox token matching, user's workspace switcher) — all annotated.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test    # 182 tests
# live: docker compose up, cp .env.example .env, then
pnpm --filter @inboxbondhu/api start
# walk: register → login(401 unverified) → verify → login → /me → refresh
#       → PATCH /w/:id (428 → 200 → 409) → logout → 401 SESSION_REVOKED
```
