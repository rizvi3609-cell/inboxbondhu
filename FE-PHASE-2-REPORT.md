# FE Phase 2 — Inbox + Thread (the signature screen): report

**Status: done.** Typecheck clean, lint clean, **355/355 tests green**, bundle budget green (15 routes ≤ 170 kB). **CON-03 drill passed live: webhook → animated socket arrival in 58 ms** through the full production pipeline (signed HMAC webhook → intake → worker ingest → rt:events bridge → gateway → connected client) — zero manual emits, measured end-to-end. PRD asks < 2 s; spec asks < 1 s; delivered 58 ms.

## What was built

### ConversationList (`components/inbox/ConversationList.tsx`) — §6.1 / Act 6
- **Signature animations (§4.2):** rows spring in (`rowEnter`, the F0 spring), `message.created` rows get the brand flash + one-shot unread-dot pulse; **handover** (`conversation.updated` with `mode:'human'`) flashes amber twice and the row FLIPs to its new sort position (`layout="position"`). One-shot classes clear on `animationend` — no re-flash on re-render.
- **Delta merges only (C-8):** realtime events and reconnects trigger `?updatedSince` fetches merged by id; a full fetch happens only on filter change. `lastSyncRef` tracks the watermark.
- Status tabs (F0 `Tabs` with counts), 300 ms debounced search (`q`), AI badge breathing, provider-glyph avatars, Bengali-font previews, `↩` outbound marker, Dhaka relative times.
- **Keyboard (§7.4):** `j`/`k` move the selection, `Enter` opens, `/` focuses search — all suppressed while typing in inputs.
- Four states: skeleton (box-matched `SkeletonRow`s) / empty (illustrated, different copy for no-results vs no-channels) / rows / — errors surface as empty + toast from the caller.

### Thread (`components/inbox/Thread.tsx`) — §6.2 / Act 6+8
- **Bubbles:** customer left with sharp top-left corner, AI violet-tinted, agent teal-tinted (`bubbleEnter` spring); status ticks 🕐/✓/✓✓ (read = brand-colored); failed = red outline + failureCode + **Retry hidden for `WINDOW_EXPIRED`** (P-01: "retries will never succeed").
- **Optimistic reply (§5.2.6):** the bubble appears instantly in the REAL `queued` lifecycle state — no invented state — reconciled by the follow-up load; on failure it's removed and **the text is restored to the composer**. `Idempotency-Key` per send (C-7).
- **AI thinking indicator:** inbound customer message while `mode:'ai'` → violet `TypingDots` bubble until the AI's outbound lands or handover flips the mode.
- **Scroll discipline (§4.2):** auto-scroll only when the user is at the bottom (60 px tolerance); otherwise the animated "↓ New message" pill.
- **Composer mirrors the mode:** border violet while the AI owns the thread, teal when human; disabled with the P-01 explanation when the window is closed. 422 on send → the window-closed toast, not a generic error.
- **Open-order card** above the composer (from `#41`'s `openOrder`): code, status badge, ৳total.
- `refreshSignal` prop for soft reloads (header actions) — the pane no longer remounts, **scroll position survives** take-over/resolve.

### ThreadHeader (`components/inbox/ThreadHeader.tsx`)
- Customer identity + lifetime stats (orders count, ৳ lifetime — PII fields render only when the server sent them, i.e. non-viewers).
- **Mode badge morph (§4.2):** AI↔Human crossfades via `AnimatePresence popLayout` (old scales 0.8/fades, new enters at 1.15).
- **Window countdown chip** (30 s tick): neutral → **amber < 1 h** → red "⛔ Window closed" — the agent sees P-01 coming before a send can fail.
- Take over / Return to AI / Resolve / Reopen with OCC If-Match; 409 → toast + refetch; **422 mid-capture → a proper dialog** explaining the Collecting/AwaitingConfirmation rule (§9-P4) instead of an error blob.

### Pages
- **`inbox/page.tsx`:** true split-pane ≥ 1024 px (380 px list + flex thread — the Act 6 layout). Desktop selection swaps the pane **without navigation** (instant) while `replaceState` keeps the URL shareable (`?c=<id>`); below 1024 px the list navigates to the thread route. `matchMedia` drives the breakpoint.
- **`inbox/[conversationId]/page.tsx`:** the mobile/deep-link thread — same components, back link, deep links always work on any viewport.

## The acceptance drill (run live, full stack)

```
mongod RS + redis + api + worker + dashboard (production build) all booted
register → verify → login through the dashboard proxy (port 3000)
channel connected for page f2-page-777
signed webhook POSTed → real pipeline → socket client in the workspace room
RESULT: {"webhookStatus":200,"socketLatencyMs":58,
         "preview":"ei blue saree ta dam koto? stock e ase?","direction":"inbound"}
dashboard proxy list: 1 conversation, correct preview, mode:ai, unread:1
```

## Deviations / flags — stated plainly
1. **Drill hiccup, my own fixture bug:** the hand-inserted channel doc went to lowercase `channelconnections`; mongoose uses `channelConnections`. The event correctly went `orphaned` (exactly what §9-P3 says unknown pages do — the system behaved right, my seeding was wrong). Fixed by moving the doc; noted because the orphaned path visibly worked as designed.
2. **Media bubbles render `[image]`-style placeholders** — the C-14 "view in Messenger" fallback needs `media.fetchStatus` + a URL, which the message list API doesn't expose yet (attachments carry `spacesKey` only, and Spaces is still the P9-flagged mock). Deferred with the media stack; not silently dropped.
3. **Assign-to-agent UI not built** (the API supports `assignedTo`) — team pickers belong with F4's team page; the PATCH path is proven by take-over/resolve.
4. Desktop pane-swap uses `replaceState` rather than router navigation — deliberate (§6.1 "fast"): no RSC round-trip per selection. Deep links still route through the real page.
5. Thread fetches `limit=100` newest without upward pagination — matches the spec's thread contract (cursor exists server-side); older-history pagination is a fast-follow if 100 proves short in practice.

## How to verify
```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build:web
# live: log in → Inbox → j/k/Enter/'/' · watch a row flash in when a webhook fires
# (tools: the F2 drill script pattern in this report's history)
```
