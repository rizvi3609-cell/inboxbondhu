/**
 * §10.4 — the grounding gate, the zero-hallucination control. Runs AFTER the
 * model returns, BEFORE anything is enqueued. Block → handover, never send.
 */
import type { AiDecision } from './schema.js'
import { FACTUAL_INTENTS } from './schema.js'
import type { RetrievedDoc } from './retrieval.js'

export type GroundingResult =
  | { ok: true }
  | { ok: false; blockReason: string }

/** Pull every number that looks like a price/quantity claim out of a reply. */
export function extractNumbers(reply: string): number[] {
  const out: number[] = []
  // ৳1,499 / 1499 taka / tk 1499 / 1499.50 — normalise digit groups.
  const re = /(?:৳|tk\.?\s*|taka\s*)?([\d,]+(?:\.\d+)?)(?:\s*(?:taka|tk|৳))?/gi
  for (const m of reply.matchAll(re)) {
    const raw = m[1]!.replace(/,/g, '')
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

export function verifyGrounding(
  decision: AiDecision,
  retrieved: RetrievedDoc[],
  maxDiscountPercent: number,
): GroundingResult {
  const retrievedIds = new Set(retrieved.map((d) => d.id))

  // Rule 1 — factual intents must cite.
  if (FACTUAL_INTENTS.has(decision.intent) && decision.action !== 'handover') {
    if (decision.sourceIds.length === 0) {
      return { ok: false, blockReason: 'factual intent with empty sourceIds' }
    }
  }

  // Rule 2 — every cited id must have been retrieved THIS turn.
  for (const id of decision.sourceIds) {
    if (!retrievedIds.has(id)) {
      return { ok: false, blockReason: `fabricated sourceId ${id}` }
    }
  }

  if (decision.reply) {
    const cited = retrieved.filter((d) => decision.sourceIds.includes(d.id))

    // Rule 3 — every number in the reply must match a retrieved value exactly.
    // Allowed numbers: cited docs' taka prices (and minor), variant prices,
    // availability counts, plus any number present in cited FAQ text.
    const allowed = new Set<number>()
    for (const d of cited) {
      if (d.priceTaka !== null) allowed.add(d.priceTaka)
      if (d.priceMinor !== null) allowed.add(d.priceMinor / 100)
      if (d.available !== null) allowed.add(d.available)
      for (const v of d.variants ?? []) {
        allowed.add(Math.floor(v.priceMinor / 100))
        allowed.add(v.available)
      }
      for (const n of extractNumbers(d.text)) allowed.add(n)
      for (const n of extractNumbers(d.name)) allowed.add(n)
    }
    // Benign small numbers (quantities the customer said, "1 din", sizes)
    // below 10 are not price-shaped; the gate targets money-shaped claims.
    // Percent-shaped numbers ("20%") are DISCOUNTS — rule 5's jurisdiction,
    // so they are excised before the price scan names them misleadingly.
    const replyForPriceScan = decision.reply.replace(/\d{1,3}\s*%/g, '')
    const numbers = extractNumbers(replyForPriceScan).filter((n) => n >= 10)
    for (const n of numbers) {
      if (!allowed.has(n)) {
        return { ok: false, blockReason: `number ${n} not in any cited document` }
      }
    }

    // Rule 4 — availability claims must match live stock.
    const claimsAvailable = /stock e ache|ache!|available|pawa jabe|in stock/i.test(decision.reply)
    if (claimsAvailable && cited.some((d) => d.type === 'product')) {
      const anyAvailable = cited.filter((d) => d.type === 'product').some((d) => (d.available ?? 0) > 0)
      if (!anyAvailable) {
        return { ok: false, blockReason: 'claims availability but live stock-reserved is 0' }
      }
    }

    // Rule 5 — discount cap (three-layer money-loss control, AI layer).
    const discountMatch = /(\d{1,3})\s*%\s*(?:discount|off|chhar|char)/i.exec(decision.reply)
    if (discountMatch && Number(discountMatch[1]) > maxDiscountPercent) {
      return { ok: false, blockReason: `discount ${discountMatch[1]}% exceeds cap ${maxDiscountPercent}%` }
    }
  }

  return { ok: true }
}
