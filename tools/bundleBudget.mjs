/**
 * FRONTEND-SPEC §5.1 — bundle budget gate. Parses `next build` output from
 * stdin and fails when any route's First Load JS exceeds the budget.
 *
 * Usage: npx next build | tee build.log ; node tools/bundleBudget.mjs < build.log
 */
import { readFileSync } from 'node:fs'

const FIRST_LOAD_BUDGET_KB = 170 // app-shell routes (spec §5.1)
const EXEMPT = new Set(['/design']) // internal demo route, not shipped nav

const input = readFileSync(0, 'utf8')
const lines = input.split('\n')

let routesSeen = 0
const failures = []
for (const line of lines) {
  // e.g. "├ ƒ /w/[workspaceId]/inbox   2.29 kB   111 kB"
  const m = /[├└┌]\s+[ƒ○●]\s+(\S+)\s+[\d.]+\s*k?B\s+([\d.]+)\s*(kB|MB)/.exec(line)
  if (!m) continue
  routesSeen += 1
  const [, route, sizeStr, unit] = m
  const kb = unit === 'MB' ? Number(sizeStr) * 1024 : Number(sizeStr)
  if (EXEMPT.has(route)) continue
  if (kb > FIRST_LOAD_BUDGET_KB) {
    failures.push(`${route}: ${kb} kB first-load > ${FIRST_LOAD_BUDGET_KB} kB budget`)
  }
}

if (routesSeen === 0) {
  console.error('BUNDLE BUDGET: no routes found in build output — the gate did NOT run. Pipe `next build` output in.')
  process.exit(1)
}
if (failures.length > 0) {
  console.error('BUNDLE BUDGET EXCEEDED:\n- ' + failures.join('\n- '))
  process.exit(1)
}
console.log(`bundle budget OK (${routesSeen} routes, all ≤ ${FIRST_LOAD_BUDGET_KB} kB first-load)`)
