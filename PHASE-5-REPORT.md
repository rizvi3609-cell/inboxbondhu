# Phase 5 — Catalogue & Knowledge (MOD-06, MOD-07): report

**Status: DoD passed.** Lint clean, typecheck clean, **261/261 tests green (28 files)** — 19 new Phase 5 tests.

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| 5000-row CSV imports with a per-row error report | Full 5000-row test (realistic: 3 variant-rows per SKU merging into ~1667 products): completes, 50 bad rows collected as `{row, column, code, message}`, `lastProcessedRow: 5000`, counts exact. |
| **Kill worker mid-import + restart → zero duplicates (MVP gate #9)** | Deterministic crash: process dies AT the row-300 checkpoint write. Checkpoint 200 durable; rows 200–299 inserted but unrecorded. Restart resumes from 200, redoes 100 rows — final count **exactly 350 products, 350 distinct SKUs**. The E11000-on-redo path counts as success, not failure. |
| A cell starting `=cmd()` is neutralised | Unit + end-to-end: `=cmd()|shell` in a real CSV lands in the DB as `cmd()|shell`. All six prefixes (`=` `+` `-` `@` `\|` TAB) stripped; normal Banglish text untouched. |
| A draft FAQ is provably unreachable by retrieval | `retrieveApprovedFaqs` has `status: 'approved'` INSIDE the query (US-014). Test proves: approved reachable, draft invisible, archived-after-approval invisible, no draft text leaks, and cross-tenant FAQs invisible. |

## What was built

**MOD-06 catalogue** (`packages/core/src/modules/catalogue/`):
- **`csv.ts`** — strict UTF-8 decode (`TextDecoder fatal: true`; latin-1 mojibake → clear "re-save as UTF-8" message), RFC-4180-ish parser (quoted fields, escaped quotes, CRLF), the six-prefix formula neutraliser applied to EVERY cell including headers, per-row validation (SKU regex, name 2–200, price > 0 ≤ ৳9,999,999 with 2-dp check, stock integer bounds).
- **`service.ts`** — product CRUD: create (plan cap checked first: 50/500/2000 → `429 PLAN_LIMIT_EXCEEDED`), update via document-save so the `searchText` pre-validate hook always runs (OCC, restore `archived → active` per PRD §2.5), **DELETE = archive, row retained** (R17 provenance), E11000 → friendly 409.
- **CSV import pipeline** — `startImport` (encoding + header + ≤ 5000 rows validated up front), `processImport` (worker side, concurrency 1): resume from `lastProcessedRow`, **checkpoint every 100 rows**, same-SKU rows merge as variants, **cap enforced during import** (trial cap test: 50 succeed, 30 fail `PLAN_LIMIT_EXCEEDED`), cancel honoured at the next checkpoint, errors capped at 500 via `$slice`.

**MOD-07 knowledge** (`packages/core/src/modules/knowledge/`):
- CRUD with `status` starting `draft`; `POST /:id/approve` (draft-only → `INVALID_STATE_TRANSITION` otherwise) setting `approvedBy`.
- **Editing an approved question/answer reverts it to draft** — the merchant must re-verify what the AI may say. (Not spelled out in §9 Phase 5; it follows from US-014's intent. Flagged below.)
- **The 500/2000 asymmetry proven by test**: Zod edge rejects 501 chars; the DB model accepts 2000 and rejects 2001. Not harmonised, per gotcha #7.
- `retrieveApprovedFaqs` — the Phase 6 retrieval hook: text search on I37, approved-inside-the-query, score < 0.4 dropped (§10.3).

**Routes #46–57** wired with the full middleware chain: viewer reads, **admin-only mutations** (§8.7 — agents cannot touch products/FAQs), If-Match discipline on PATCH, import rate-limited 5/hr per workspace, 202 for import start.

**Worker**: `csv-import` processor (concurrency 1 from the Phase 0 queue table) wired to `processImport`.

## Deviations / flags — stated plainly

1. **Spaces storage still absent** — the CSV rides on `imports.spacesKey` as `inline:<text>` (1 MB request cap keeps this bounded). Same reason as the Meta client: no credentials to verify an S3 client against. `// OPEN QUESTION` in the service; swap is one function when the storage integration lands (it also unblocks `media-fetch` and multipart upload).
2. **`POST /products/import` takes JSON `{fileName, content, encoding}`** rather than true multipart — multipart parsing arrives with the storage integration (busboy/multer belongs with real file streaming, not the inline interim).
3. **Edit-reverts-approval** is my inference from US-014 ("a draft answer can never reach a customer" — an *edited* approved answer is unreviewed content). If the api-spec says edits keep approval, deleting 4 lines reverts the behaviour.
4. **Description ≤ 2000 at the API edge** per §9 Phase 5 item 1 (DB ceiling 4000 per the Phase 1 model) — another deliberate edge-vs-DB asymmetry, preserved not harmonised.
5. **PRD §2.5's "products with orders are archived"** — the *distinction* (delete-if-no-orders vs archive-if-orders) is NOT implemented: DELETE always archives, which is the safer superset and matches §9 Phase 5's "`DELETE` = archive" verbatim. prompt.md wins on precedence here.

## Cross-phase alignment

- `retrieveApprovedFaqs` is the exact interface Phase 6's retrieval stage consumes (top-3 FAQs, 0.4 score floor already applied).
- Import checkpoints ride Phase 1's `imports.lastProcessedRow` + I59; products land on I32 (`{workspaceId, sku}` unique) which IS the zero-duplicates guarantee.
- The `csv-import` queue uses Phase 0's concurrency-1 setting — the reason checkpoints stay coherent.
- Plan caps read `workspaces.plan` (Phase 1) — the same numbers `usageLedger.productsCount` will reconcile against in Phase 8.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test   # 261 tests (~50 s — the 5000-row import is real)
```
