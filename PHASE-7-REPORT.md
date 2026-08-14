# Phase 7 — Orders & Payments (MOD-08, MOD-09), CP-3: report

**Status: DoD passed.** Lint clean, typecheck clean, **305/305 tests green (31 files)** — 20 new Phase 7 tests. One **genuine spec conflict found and reported** (below).

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| **20 concurrent confirmations of the last unit → exactly 1 success, 19 × 422, `reserved == stock` (MVP gate #4)** | 20 independent `AwaitingConfirmation` orders race `confirm()` on a 1-unit variant: **1 success, 19 `BUSINESS_RULE_VIOLATION`**, `reserved: 1 == stock: 1`, exactly one held reservation, exactly one order code (`ORD-YYYY-00001`). |
| The client cannot influence `totalMinor` | Two layers proven: the strict Zod contract **rejects** a body carrying `totalMinor` outright (unknown key), and all five money fields are recomputed server-side from snapshots via the `Money` kernel. A post-creation price change does not rewrite the snapshot. |
| Agent applying a discount → 403 | `discountPercent > 0` from an `agent` → `INSUFFICIENT_PERMISSIONS` at create AND update (the §8.7 carve-out, in the service, not the route role). |
| 51 % discount → 422 | Rejected at the Zod edge (max 50); a 40 % request against a 30 % workspace cap → `BUSINESS_RULE_VIOLATION` in the service — the layered money-loss control. |
| Abandoned draft cancelled + stock released after 24 h | `sweepAbandonedOrders(24)`: a 25 h-stale `Collecting` draft → `Cancelled(system_abandoned)` with history appended; a fresh draft untouched; reservations (if any) released in the same transaction. |

## What was built

- **`stateMachine.ts`** — the explicit `FULFILLMENT_TRANSITIONS` / `PAYMENT_TRANSITIONS` maps (§11.1). Shipped/Delivered terminal for cancellation; `PaymentFailed → PaymentPending` retry loop present; carve-out role sets exported.
- **T1 verbatim (§11.4)** — the five-collection transaction: OCC claim (`AwaitingConfirmation` filter = retry-safe), order number **only on first confirmation** (`!orderCode` guard; year-scoped counter), the atomic `$expr` oversell guard, `held` reservation rows (+24 h), `order.confirmed` outbox (order-scoped idempotencyKey → exactly once, proven), audit with role-at-time.
- **Reservation lifecycle (§11.5)** — all four rows tested: confirm `+reserved`; cancel `−reserved`/released (stock untouched); Processing `−reserved −stock`/committed; expiry sweeper releases AND decrements **in one transaction** (DB-07 — why D14 has no TTL), idempotent on re-run.
- **`buildOrderFields`** — the only money writer: add-time `unitPriceMinor` snapshot (`variant.priceMinor ?? basePriceMinor`), `Money.mulQty/floorPercent/add/sub`, zone fee from workspace `deliveryZones` with the **PRD §2.9 Dhaka normaliser** (`Dkha`/`dhaka city`/`ঢাকা` → Dhaka; unknown → Outside Dhaka), live-availability check at add time (DF-02's confirm-time 422 remains the real guard).
- **Endpoints #58–65**: list (I39/I40 filters, cursor), get, create (Idempotency-Key; replay 200 with the ORIGINAL even for a different body), update (If-Match; details frozen after confirmation; transitions via the map — `Confirmed`/`Cancelled` redirected to their dedicated endpoints), confirm (T1), cancel (releases holds; Processing→Cancelled carve-out with audited reason), `GET /payments/providers` (COD enabled, bKash/Nagad/Rocket `comingSoon`), `POST /orders/:id/payment-link` → **the one `501`**.
- **`PaymentsService` + `CodProvider`** (§11.7 honest interface) — COD cash recording `Unpaid → Paid` with the PRD §2.10 conflict rule: **payment against a cancelled order is rejected**, never blindly marked paid.
- **Split status proven end-to-end**: an order walked to `Delivered` while `Unpaid` (legal — ADR-008), then cash → `Paid`; Shipped/Delivered emit customer-notify outbox events (PRD §2.9).
- **Sweepers wired** in the worker under Redis job locks: `reservationExpirySweeper` (5 min), `abandonedOrderSweeper` (15 min).

## The genuine spec conflict — reported, not coded around

**§11.4's verbatim snippet is not valid MongoDB.** It places `$expr` *inside* `$elemMatch`; MongoDB rejects this with `"$expr can only be applied to the top-level document"` (verified live against Mongo 7.0.24 — 8 tests failed on the literal form). Per agent.md §2 I must report rather than silently pick: **I implemented the semantically identical legal form** — a top-level `$expr` mapping over `variants` (`sku` match AND `stock − reserved ≥ qty`) plus `'variants.sku'` binding the positional `$`. Check-and-decrement remain one atomic operation on one document; the race test proves the guarantee is intact. Notably, **agent.md §6.2's own exemplar has the same illegal shape** — both documents need the correction. The Phase 1 test suite already used the legal form, which is why this only surfaced when T1 was transcribed verbatim.

## Deviations / flags — stated plainly

1. **`orders.orderNumber/orderYear/orderCode` are now optional-until-confirm** (partial unique I38/I39 replacing full-unique). database.md §2.12 marks them required, but T1 — mandated verbatim — assigns them *only at first confirmation*, so `Collecting`/`AwaitingConfirmation` drafts structurally cannot carry them. Flagged as a database.md↔prompt.md tension; prompt.md's T1 wins on the session instruction ("T1 verbatim"). Set-once is now enforced by T1's `!orderCode` guard rather than schema immutability (the Phase 1 immutability test was updated accordingly — stated openly).
2. **I42 re-keyed to `draftLastTouchedAt`** (from `createdAt`) per §11.2/§13.2 and architecture.md:568 — the sweeper's actual query key. `draftLastTouchedAt` added to the model.
3. **§11.2 conversational draft capture (AI-driven `draft_order` upsert)** is scaffolded but not end-to-end: the AI pipeline returns `action: 'draft_order'` with extracted fields (Phase 6) and manual creation covers the agent path; the AI→draft merge loop needs conversational state that belongs with the Phase 6↔7 integration pass. Trigger 12 (contradiction handover) already fires in the pipeline. Flagged as the largest remaining §11 gap.
4. **`transition()` for Shipped/Delivered writes the outbox outside a transaction** (single-document status change + outbox insert). T1/cancel/processing — where multi-document atomicity is load-bearing — use `withTx`; a Shipped-notify outbox row is retried by the dispatcher anyway. Narrow reading of "only these four transactions".
5. **`GET /payments/providers` reports `enabled/comingSoon`** per §11.6/PRD §2.10 wording ("online as enabled: false").

## Cross-phase alignment

- T1's oversell guard is the exact pattern the Phase 1 test suite proved (20-way race there, 20-way race here — now through the full service with counters, outbox, audit).
- `Order.recalculate()` (Phase 1, Money-kernel-backed since Phase 0 retrofit) remains the document-level writer; `buildOrderFields` is its service-level twin for construction.
- Phase 4's return-to-AI block reads the same mid-capture states this phase's machine defines.
- The idempotency store is Phase 4's (`order:`-prefixed keys); the same 428/200-replay discipline as #44.
- `order.confirmed` / `order.shipped` / `order.delivered` outbox events await Phase 8's dispatcher — nothing external inside transactions (INV-10).

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test   # 305 tests, incl. the 20-way race
```
