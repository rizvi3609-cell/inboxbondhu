# FE Phase 3 — Orders + Catalogue + Knowledge: report

**Status: done.** Typecheck clean, lint clean, **355/355 tests green**, bundle budget green (15 routes ≤ 170 kB). Every flow the pages depend on **verified live through the dashboard proxy** against the running full stack (evidence below).

## What was built

### Orders (`orders/page.tsx`) — §6.3
- **State-machine-driven actions:** `NEXT_ACTIONS` mirrors the server's `FULFILLMENT_TRANSITIONS` (UI sugar only, C-9 — the service re-validates): AwaitingConfirmation→Confirm (primary), Confirmed→Start processing, Processing→Mark shipped, Shipped→Mark delivered. Cancel offered on all four cancellable states with the **Processing-needs-admin** note in the dialog.
- **Confirm is NEVER optimistic** (§5.2.6): T1 decides via the stock race. A 422 shakes the row and surfaces the server's message verbatim with the requestId (DF-02: "surface it clearly, never silently drop the item").
- **`order.updated` socket → §4.2 badge crossfade** (old scales .8/fades, new enters 1.15) + one brand row-flash; OCC 409 → toast + refresh; 403 on transitions → plain-language permission message.
- **Expandable detail** (animated height): item lines with snapshots, money breakdown (subtotal/discount/delivery/total — all `taka()` from Minor ints, C-12), recipient + Bengali-font address, "💬 View conversation" deep link into the F2 thread.
- **Cancel-with-reason dialog** — reason required (server contract), reservations-released copy, audit note.
- Status filter tabs; table degrades to wrapped cards on narrow screens via flex-wrap.

### Catalogue (`catalogue/page.tsx`) — §6.4
- **Drag-drop CSV zone**: dashed border + background + 1.005 scale animate on drag-over; browse fallback; client-side .csv extension check.
- **Live import progress**: socket `import.progress` first (F2 pipeline), 2 s poll as the §12.4 best-effort fallback; bar springs to each checkpoint; completion swaps in the SVG **✓ draw-in**; cancel button ("cancelling at the next checkpoint" — the real §6.4 semantics).
- **US-012 per-row error report**: expandable table (row / column / message) straight from `ImportView.errors`; shown after completion when `failureCount > 0`.
- Products: SKU/name/৳price/stock **with reserved shown** and per-variant **Available = stock − reserved** (red at ≤0 — the oversell picture at a glance); variants expander (animated height); archive → restore (restore = PATCH `status:'active'` per the service's documented path); archived rows at 65 % opacity.
- `PLAN_LIMIT_EXCEEDED` → upgrade CTA copy; `RATE_LIMITED` → the 5/hr message.

### Knowledge (`knowledge/page.tsx`) — §6.5
- Draft→approve flow framed exactly as the spec asks: "The AI answers **only** from approved FAQs — a draft is invisible to it."
- **Approve** = primary action with the ✓ draw-in beside the badge (§4.2).
- **Edit dialog** with the US-014 warning banner when editing an approved FAQ ("returns it to draft — the AI stops using it until re-approved").
- **The C-6 ConflictDialog in real use:** PATCH → 409 → refetch theirs → per-field Yours/Theirs diff → *Reapply my change* re-PATCHes **on the fresh version**, *Keep theirs* closes and reloads. Never a silent retry. Deleted-under-you handled too.
- Bengali-font question/answer everywhere; drafts-count tab chip.

### Contract fix caught by C-11 (flagged, fixed)
My own `views.ts` had a **wrong paymentStatus enum** (`PartiallyPaid`/`Failed` — fields that never existed; truth is `Unpaid|PaymentPending|PaymentFailed|Paid|Refunded` per the model + ADR-008 state machine). Fixed in contracts + the `toneFor()` status map. Second time the shared-types gate caught real drift — once in F1 (`customerName`), now in F3. The pattern works.

## Live verification (dashboard proxy, full stack: mongod RS + redis + api + worker + production web build)

```
CSV import   250 rows (247 good + 3 engineered-bad) → status completed,
             250/250 processed, error report rows pinpointed with column names
             (also caught my fixture's missing variant_sku column — the strict
             header validation working as designed)
Knowledge    colleague-edit v0→v1, my stale If-Match:0 → 409
             {currentVersion:1, conflictingFields:["answer"]} → reapply on
             If-Match:1 → 200   (the exact ConflictDialog loop)
Orders       create → confirm (T1) → "Confirmed | ORD-2026-00001 | createdAt ✓"
             → Processing 200 → Shipped 200 → Delivered 200
             Delivered→Processing → 409 INVALID_STATE_TRANSITION
Stock guard  quantity 8 of 6 available → BUSINESS_RULE_VIOLATION
             "Only 6 of F3 Product 0 Nice (F3-000-M) available."
```

## Deviations / flags — stated plainly
1. **The import drill's 200 "sku" errors were my fixture's fault, not a bug**: rows 51+ reused SKUs already imported by an earlier partial run against the same workspace (duplicate-SKU-merges-variants rule kicked in with same-variant-sku conflicts). The engineered rows 248–250 produced exactly the expected name/price/sku errors. Import logic itself was proven at P5 with 5000 rows; the UI consumes whatever `errors[]` says.
2. **Create-order response is the flat order object** (`data.id`), not `{order}` as `OrdersService.create` returns internally — the route unwraps. The page only consumes list/GET shapes (`OrderView`) so no code change needed; noted for the F4+ order-create UI if one is added.
3. **Manual order creation UI not built** — the spec's #60 exists for agents, but user-story Act 8 has agents creating orders *from the conversation*; that entry point belongs in the F2 thread (fast-follow) rather than a floating form on the orders page. Flagged, not dropped.
4. **No date-range filter on orders yet** (§6.3 mentions it) — status tabs cover the workflow need; range filter rides with F5's analytics range-picker component to avoid building two date pickers.
5. Payment badges render all five real states; `recordCodPayment` UI (mark COD collected) is part of the Delivered+Unpaid flow — deferred to F4 settings/ops polish with a flag here.

## How to verify
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:web
# live: Catalogue → drop a CSV → watch the bar spring per checkpoint → error report
# Knowledge → edit the same FAQ in two tabs → the 409 diff dialog appears
# Orders → expand a row → walk Confirm → … → Delivered; badges crossfade
```
