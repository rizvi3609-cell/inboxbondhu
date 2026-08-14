/**
 * MOD-05 schemas — AiDecision verbatim from §10.2, the intent groups the
 * gates key off, and the injection pre-filter patterns (§10.6 rule 3).
 */
import { z } from 'zod'

export const AiDecision = z
  .object({
    intent: z.enum([
      'greeting', 'product_search', 'price_question', 'availability_question',
      'delivery_question', 'size_or_color_question', 'order_start',
      'provide_customer_detail', 'order_confirmation', 'payment_question',
      'complaint', 'human_request', 'unknown',
    ]),
    confidence: z.number().min(0).max(1),
    action: z.enum(['reply', 'ask', 'draft_order', 'handover']),
    reply: z.string().max(1000).nullable(),
    extracted: z.object({
      name: z.string().nullable(),
      phone: z.string().regex(/^01[3-9]\d{8}$/).nullable(), // BD mobile
      address: z.string().nullable(),
      zone: z.string().nullable(),
      productId: z.string().nullable(),
      variantSku: z.string().nullable(),
      quantity: z.number().int().positive().nullable(),
    }),
    sourceIds: z.array(z.string()), // MUST cite retrieved doc IDs
    handoverReason: z.string().nullable(),
  })
  .strict()
export type AiDecision = z.infer<typeof AiDecision>

/** Intents that MUST cite sources (§10.4 rule 1). */
export const FACTUAL_INTENTS: ReadonlySet<AiDecision['intent']> = new Set([
  'price_question', 'availability_question', 'delivery_question', 'size_or_color_question', 'product_search',
])

/** Intents that always hand over (§10.5 trigger 2). */
export const HANDOVER_INTENTS: ReadonlySet<AiDecision['intent']> = new Set([
  'complaint', 'human_request', 'payment_question', 'unknown',
])

/** §10.6 rule 3 — known injection patterns → forced handover, audited. */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|the\s+)?previous/i,
  /disregard\s+(all\s+|the\s+)?(previous|above)/i,
  /you\s+are\s+now/i,
  /^\s*system\s*:/im,
  /<\/?\s*(system|assistant|customer_message|retrieved_docs)\b/i,
  /তুমি এখন/,
  /আগের নির্দেশ/,
  /act\s+as\s+(a\s+)?(dan|jailbreak|developer\s+mode)/i,
  /new\s+instructions?\s*:/i,
]

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text))
}

/** §10.3 — Banglish transliteration/normalisation map for retrieval. */
const BANGLISH_MAP: ReadonlyArray<[RegExp, string]> = [
  [/\bdam\b/gi, 'price dam'],
  [/\bkoto\b|\bkotota\b|\bkoto\s*taka\b/gi, 'how much price'],
  [/\bache\b|\base\b/gi, 'available ache'],
  [/\bjama\b/gi, 'jama জামা'],
  [/\bsari\b|\bshari\b|\bsaree\b/gi, 'saree shari শাড়ি'],
  [/\bpanjabi\b|\bpunjabi\b/gi, 'panjabi পাঞ্জাবি'],
  [/\bkurti\b/gi, 'kurti কুর্তি'],
  [/\bdelivery\b|\bdelibhari\b/gi, 'delivery'],
  [/\bcharge\b|\bcharj\b/gi, 'charge fee'],
  [/\bstock\b|\bishtok\b/gi, 'stock available'],
  [/\bsize\b|\bsaij\b/gi, 'size'],
  [/\brong\b/gi, 'color rong'],
  [/\bkalo\b/gi, 'black kalo'],
  [/\blal\b/gi, 'red lal'],
  [/\bnil\b/gi, 'blue nil'],
  [/\bfabric\b|\bkapor\b|\bkapor er\b/gi, 'fabric kapor'],
  [/\breturn\b|\bferot\b/gi, 'return ferot'],
  [/\bexchange\b|\bbodol\b/gi, 'exchange bodol'],
]

export function normaliseBanglish(text: string): string {
  let out = text
  for (const [re, replacement] of BANGLISH_MAP) out = out.replace(re, replacement)
  return out
}

/** Pure Bengali script detector for handover trigger 8. */
export function isPureBengali(text: string): boolean {
  const letters = text.replace(/[\s\d\p{P}]/gu, '')
  if (letters.length === 0) return false
  const bengali = [...letters].filter((c) => /[\u0980-\u09FF]/.test(c)).length
  return bengali / letters.length > 0.8
}
