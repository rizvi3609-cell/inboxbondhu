# FE Phase 0 — Bondhu design system: report

**Status: done.** Typecheck clean (all 8 projects), lint clean, `next build` clean, **bundle budget gate green (15 routes, all ≤ 170 kB first-load)** and now CI-enforced. Live demo at `/design` (public route) rendering every primitive in both themes.

## What was built

**Tokens (`globals.css`)** — FRONTEND-SPEC §3.2 verbatim: warm-paper light theme + first-class dark theme (`html[data-theme=dark]`, full mirrored token set, `color-scheme: dark`); brand teal / AI violet / taka amber; radius + shadow + easing + duration scales; 8 shared keyframes (`shimmer`, `pulse-once`, `breathe`, `row-flash`, `row-flash-warn`, `shake`, `draw-check`, `dot-bounce`) exposed as utility classes.

**Fonts** — `next/font`: Inter (variable, latin, preloaded) + Noto Sans Bengali (variable, `preload: false` — loads only when Bengali text renders; UI chrome is Latin). Zero external font requests (C-5 CSP + BD network reality). Tabular numerals class for money/counts.

**Theme system** — no-FOUC boot: an inline script (carrying the middleware's CSP nonce, C-5) reads `localStorage['ib-theme']` before first paint; falls back to `prefers-color-scheme`. `ThemeToggle` crossfades surfaces via a transient `theme-transition` class instead of hard-flashing.

**Motion setup (`lib/motion.tsx`)** — Motion via `LazyMotion` + `domAnimation` + `strict` (importing the full `motion` component now throws — the budget is protected structurally). One spring (420/32) and six shared variant sets: `rowEnter`, `bubbleEnter`, `cardEnter`, `pageEnter`, `dialogEnter`, `sheetEnter`. Global reduced-motion decay in CSS (§4: everything collapses to ~80 ms opacity).

**Primitives (14, §3.4)** — `Button` (4 variants; loading preserves width — label hides, spinner overlays; §4.3 press scale), `Spinner`, `Badge` (+ `toneFor()` — the ONE map from every backend status string to a tone, so status colors can never drift per-page; `breathing` prop = the §4.2 AI glow), `Card`, `Skeleton` + `SkeletonRow` (shimmer; row skeleton box-matched to the conversation row → zero CLS), `Avatar` (deterministic oklch hue from id + FB/IG provider glyph), `EmptyState`, `Meter` (mount-animated width; amber pulse ≥ 80 %, red ≥ 100 % — §4.2 quota), `Tabs` (active pill with soft transition + count chips), `CheckDraw` (SVG stroke-dashoffset ✓, §4.2 import completion), `TypingDots` (AI thinking), `Kbd`, `Dialog` (portal, focus trap + restore, Esc, backdrop fade + panel spring), `ConflictDialog` (**C-6: the 409 dialog — per-field Yours/Theirs diff + [Reapply my change] / [Keep theirs]**), `ToastProvider`/`useToast` (stacked bottom-right, layout-animated via `AnimatePresence popLayout`, errors persist with copyable requestId, others auto-dismiss 3.5 s).

**`/design` gate route** — every primitive live: badge map across all backend statuses, avatar hues, quota meter at 64/85/100 %, a "simulate message.created" button that spring-enters rows with the brand flash, both dialogs, all four toast kinds, Bengali rendering check (`এই জামাটার দাম কত?`). Public (added to middleware PUBLIC_PATHS), not linked from any nav.

**Bundle budget gate (`tools/bundleBudget.mjs`)** — parses `next build` output, fails CI when any route's First Load JS exceeds 170 kB; **fails loudly on empty input** (a silent no-op gate is worse than no gate — caught during this phase when the first wiring attempt piped nothing and "passed"). `/design` exempt (internal). Wired as `pnpm build:web` and into CI.

## Numbers

| Route class | First Load JS | Budget |
|---|---|---|
| Shared shell (all app routes) | 105–111 kB | ≤ 170 kB ✅ |
| `/design` (Motion + every primitive) | 154 kB | exempt (demo) — still under budget |

Motion's real cost measured: ~43 kB on the one route that imports everything. App routes will pull only the variants they use.

## Deviations / flags

1. **Emoji glyphs as icons** (🤖 ✓ ⚠ etc.) for F0 — consistent with the user-story mockups which use them. If pixel-perfect icons are wanted later, an inline-SVG icon set is a drop-in (budget ~2 kB); flagged, not decided.
2. **Inline styles over CSS modules** for primitives — deliberate: tokens do the theming, components stay single-file and tree-shakeable, and there's no class-name collision surface. Table/form base styles live in globals. Revisit only if style duplication actually bites.
3. `/design` ships in the production bundle (154 kB route). Harmless (no data access, public), useful for QA on deployed envs. Can be env-gated later if desired.
4. The old P9 pages still render with legacy inline styles — they get rebuilt on the new system in F1–F5 per the plan; F0 deliberately did not touch them (one phase, one concern).

## How to verify

```bash
pnpm typecheck && pnpm lint
pnpm build:web            # includes the §5.1 budget gate
# live: open /design — toggle theme, simulate rows, open the 409 dialog
```
