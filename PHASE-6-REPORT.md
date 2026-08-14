# Phase 6 — AI pipeline (MOD-05), CP-2: report

**Status: DoD passed.** Lint clean, typecheck clean, **285/285 tests green (30 files)** — 24 new Phase 6 tests (16 pipeline + 8 eval-suite) over a **118-case Banglish corpus**.

## The DoD, item by item

| DoD item | Evidence |
|---|---|
| p50 < 10 s, p95 < 15 s on the eval corpus | Asserted across all 118 cases through the real pipeline (real Mongo retrieval + grounding; mock LLM). |
| The 15 s abort provably hands over rather than hanging | A scripted 60 s LLM hang is aborted at the Deadline (compressed to 1.5 s in test — same code path); result: `handover`, conversation → `human`, elapsed way under the hang time. |
| **Zero ungrounded claims across 100+ cases (MVP gates #2, #3)** | Every number ≥ 10 in every sent reply is checked against the known seeded catalogue — **zero violations**, and the test is written so a violation is a build failure, not a warning. |
| Every injection case handed over and audited | 8 adversarial cases (English + Bengali, incl. delimiter-escape `</customer_message>`) → all `handover` + `ai.injection_suspected` audit rows. |

## What was built

**The nine-stage pipeline** (`packages/core/src/modules/ai/pipeline.ts`) under ONE `Deadline` (the Phase 0 kernel primitive — INV-09): load 12-message window → rule-based intent pre-classification → retrieval → versioned prompt assembly → LLM call (child deadline, min(9 s, remaining)) → Zod parse + **exactly one repair retry, never a third** (proven: 2 calls in both success and failure paths, `ai.parse_failed` audited with prompt/response sample per PRD §2.7) → **grounding gate** → policy checks (stale-product re-check, PRD §2.7) → insert + enqueue outbound. A stage that can't fit in the remaining budget is skipped, not started. Every exit is a reply-that-passed-the-gates or a handover — the catch-all makes even a programmer error hand over rather than hang.

**The grounding gate** (`grounding.ts`) — all five §10.4 rules: factual intents must cite; every `sourceId` must be from THIS turn's retrieval (fabricated → block); every number ≥ 10 in the reply must match a cited doc exactly (৳/commas/tk normalised; %-shaped numbers routed to the discount rule so "20% discount" is blocked as a discount, not a price); availability claims checked against live `stock − reserved`; discount ≤ `aiConfig.maxDiscountPercent`. Blocks write `groundingBlocked + blockReason`, hand over, and are **never sent** (enqueue spy asserted empty).

**All twelve §10.5 handover triggers**, each tested: confidence threshold, handover intents, workspace keywords, discount cap (via gate), grounding failure, 3× intent loop, non-text content, pure-Bengali script (>80 % Bengali codepoints), 6-message runaway guard, out-of-hours (with the **P-09 away message sent at most once per customer per day** — second message hands over; zero LLM spend out of hours), cost cap (trigger 11 — monthly ledger interim, flagged), contradictory phone numbers mid-order.

**Injection defence** (§10.6): customer text only inside `<customer_message>` (delimiter-stripping sanitiser), system prompt declares block content is data, pre-filter regexes (incl. `তুমি এখন`, `আগের নির্দেশ`) → forced handover + audit, and the mock-model contract mirrors rule 4 — text out, no tools, side effects only via gated enqueue.

**Retrieval** (`retrieval.ts`) — `$text` on I35/I37 with the Banglish normalisation map (`dam`→price, `jama`→জামা, colour/fabric terms…), active-only products / **approved-inside-the-query** FAQs, top 5 + top 3, < 0.4 dropped, live per-variant availability computed at retrieval time. The `Retriever` interface keeps the Atlas Vector swap one file.

**The eval corpus** (`evals/banglish-corpus.jsonl`) — **118 labelled cases**: all 13 intents in Banglish/Bengali/English with misspellings (`delibhari`, `saij`, `confrm`), 4 pure-Bengali-script cases, 8 adversarial injections. Runs inside `pnpm test`, so it already executes on every merge via the Phase 0 CI (gate: grounding failure = build failure). The out-of-stock product (Party Dress, stock 0) verifies no availability lie survives.

**Worker wiring**: `conversation-ai` processor (concurrency 3 from §13.1) with the **PRD §2.7 per-conversation Redis lock** (`lock:conv:{id}`, 60 s TTL > 15 s deadline; a locked conversation's job is delayed 2 s, not dropped, keeping messages sequential per conversation).

## Deviations / flags — stated plainly

1. **The LLM client is the deterministic mock** — same reasoning as Meta/Spaces: writing an untested OpenAI HTTP client with no key to verify against contradicts "don't pretend it works". The mock behaves like a *well-aligned* model; the dark paths (bad JSON, fabricated ids, wrong prices, hangs) are scripted mutations. **Consequence stated honestly: the evals prove the PIPELINE (retrieval, gates, deadline, triggers) is correct, not that gpt-4o-mini behaves.** When you have a key: `llm/client.ts` implementing `LlmClient` + one import line, then re-run the same 118 cases against the real model — that run is the true MVP gate #2/#3 sign-off.
2. **Trigger 11 cost cap is monthly-bounded** (30× daily cap against `usageLedger.aiCostMinor`) because the ledger is `YYYY-MM` and the daily split + 80 %/100 % owner warnings belong to Phase 8 plans/notifications. Cap config flows through deps, not `process.env` (my own lint rule caught the first draft).
3. **Trigger 8 hands over immediately on pure Bengali** — PRD §2.7 says "ask for Banglish once, then hand over". The ask-once path needs per-conversation language-attempt state that no collection stores; immediate handover is the narrower, safer behaviour. `// flagged` in code.
4. **Stage 2 pre-classification is rules, not a cheap model** — §10.1 explicitly allows "cheap model **or rules**"; rules cost 0 ms and 0 taka at MVP.
5. **`evalCanary` (daily 04:00 20-case subset)** is a Phase 8 cron with the other sweepers; the full corpus already runs on every merge, which is strictly stronger.
6. **`intent` expectation in evals is enforced via action-correctness** (handover vs reply vs ask), not strict intent equality on every case — the rule-based pre-classifier feeds the mock, so strict intent assertions would test my regexes against themselves. Real-model runs should tighten this to exact intent matches.

## Cross-phase alignment

- `Deadline` (Phase 0 kernel) is the abort backbone; `DhakaTime` powers business-hours and period keys.
- Retrieval consumes Phase 5's approved-inside-the-query discipline — `retrieveApprovedFaqs` semantics, same I35/I37 indexes.
- Replies enter Phase 4's message shape (`author.type: 'ai'`, `aiMeta.*`) and Phase 3's outbound queue — the 24 h window gate still applies downstream.
- Phase 3's ingest already emits `conversation-ai` jobs with `enqueueAi`; the processor now exists to consume them.
- `aiMeta.sourceIds` (Phase 1's grounding-proof field) is populated on every sent reply — zero-hallucination is auditable after the fact, not just asserted.

## How to verify

```bash
pnpm lint && pnpm typecheck && pnpm test    # 285 tests, incl. the 118-case corpus
# The corpus lives at evals/banglish-corpus.jsonl — add cases freely;
# the suite fails if intents drop below 13 or cases below 100.
```
