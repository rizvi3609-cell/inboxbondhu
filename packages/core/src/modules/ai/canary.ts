/**
 * evalCanary (§13.2 row 9, P-10) — daily at 04:00 Dhaka under the Redis job
 * lock: run a 20-case subset of the eval corpus against the PRODUCTION prompt
 * version and alert on any regression. The full corpus already gates every
 * merge (§10.8); the canary catches drift in the live path (prompt version,
 * retrieval behaviour, grounding gate) between deploys.
 *
 * The subset is deterministic (id-sorted, stratified pick) so day-over-day
 * results are comparable. A failure is an ALERT log line, not a crash —
 * §15.5 pipes `ai.canary_failed` to Datadog.
 */
import type { LlmClient } from '@inboxbondhu/integrations'
import { AiDecision, detectInjection, isPureBengali } from './schema.js'
import { assemblePrompt, preclassifyIntent, PROMPT_VERSION_BUILTIN } from './prompt.js'
import { verifyGrounding } from './grounding.js'
import type { Retriever } from './retrieval.js'

export interface CanaryCase {
  id: string
  text: string
  expectedIntent: string
  expectedAction: string
  injection?: boolean
}

export interface CanaryResult {
  promptVersion: string
  total: number
  passed: number
  failures: Array<{ id: string; reason: string }>
}

/**
 * Deterministic 20-case pick: sort by id, take every Nth so the subset spans
 * the whole corpus (all intent families) instead of the first file block.
 */
export function pickCanarySubset(corpus: CanaryCase[], size = 20): CanaryCase[] {
  const sorted = [...corpus].sort((a, b) => a.id.localeCompare(b.id))
  if (sorted.length <= size) return sorted
  const step = sorted.length / size
  const out: CanaryCase[] = []
  for (let i = 0; i < size; i += 1) out.push(sorted[Math.floor(i * step)]!)
  return out
}

/**
 * Run the canary against a live workspace's retrieval + the given LLM client.
 * Stateless with respect to conversations — each case is a fresh single-turn
 * exchange through the SAME assemble→complete→parse→ground path the pipeline
 * uses. Grounding violations and wrong actions both count as failures.
 */
export async function runEvalCanary(
  workspaceId: string,
  cases: CanaryCase[],
  deps: {
    llm: LlmClient
    retriever: Retriever
    promptVersion?: string
    maxDiscountPercent?: number
  },
): Promise<CanaryResult> {
  const promptVersion = deps.promptVersion ?? PROMPT_VERSION_BUILTIN
  const failures: Array<{ id: string; reason: string }> = []

  for (const c of cases) {
    try {
      // Injection / pure-Bengali cases must be caught BEFORE the LLM —
      // same order as the pipeline's pre-filters.
      if (detectInjection(c.text) || isPureBengali(c.text)) {
        if (c.expectedAction === 'handover') continue // pass
        failures.push({ id: c.id, reason: 'pre-filter fired on a non-handover case' })
        continue
      }
      if (c.expectedAction === 'handover' && c.injection) {
        failures.push({ id: c.id, reason: 'injection case NOT caught by the pre-filter' })
        continue
      }

      const docs = await deps.retriever.search(workspaceId, c.text)
      const prompt = assemblePrompt({
        tone: 'friendly',
        maxDiscountPercent: deps.maxDiscountPercent ?? 10,
        recentMessages: [],
        intentHint: preclassifyIntent(c.text),
        customerMessage: c.text,
        docs,
      })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12_000)
      let raw: string
      try {
        const res = await deps.llm.complete(
          { system: prompt.system, user: prompt.user },
          { signal: controller.signal, maxTokens: 700 },
        )
        raw = res.text
      } finally {
        clearTimeout(timer)
      }

      const parsed = AiDecision.safeParse(JSON.parse(raw) as unknown)
      if (!parsed.success) {
        failures.push({ id: c.id, reason: 'AiDecision parse failed' })
        continue
      }
      const decision = parsed.data

      // Grounding gate — ANY block on a reply-expected case is a regression;
      // an ungrounded reply that PASSES the gate would be a build failure in
      // the full suite, so re-verify here too.
      const grounding = verifyGrounding(decision, docs, deps.maxDiscountPercent ?? 10)
      if (c.expectedAction === 'handover') {
        if (decision.action !== 'handover' && grounding.ok) {
          failures.push({ id: c.id, reason: `expected handover, model chose ${decision.action}` })
        }
        continue
      }
      if (!grounding.ok) {
        failures.push({ id: c.id, reason: `grounding blocked: ${grounding.blockReason}` })
        continue
      }
      if (decision.action === 'handover' && docs.length > 0) {
        failures.push({ id: c.id, reason: 'unexpected handover with retrieval hits' })
      }
    } catch (err) {
      failures.push({ id: c.id, reason: `canary error: ${(err as Error).message.slice(0, 120)}` })
    }
  }

  return { promptVersion, total: cases.length, passed: cases.length - failures.length, failures }
}
