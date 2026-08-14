/**
 * Deterministic mock LLM. Reads the structured blocks the prompt assembler
 * emits (<intent_hint>, <retrieved_docs>, <customer_message>) and behaves
 * like a well-aligned model: factual intents cite retrieved doc ids and quote
 * their exact prices; handover intents hand over. Scriptable failure modes
 * cover the pipeline's dark paths (bad JSON, fabricated ids, wrong prices,
 * hangs) so the grounding gate and deadline are testable.
 */
import { LlmError, type LlmClient, type LlmPrompt, type LlmResponse } from '../types.js'

export interface MockLlmState {
  /** Next call returns this raw text (e.g. invalid JSON), then resets. */
  nextRawText: string | null
  /** Mutates the decision object before serialisation, then resets. */
  nextDecisionMutator: ((d: Record<string, unknown>) => void) | null
  /** Delay before responding (test the 15 s abort with a short deadline). */
  delayMs: number
  calls: number
}

interface DocLine {
  id: string
  type: string
  name: string
  priceTaka: number | null
  available: number | null
  text: string
}

function parseBlock(user: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(user)
  return m?.[1]?.trim() ?? ''
}

function parseDocs(user: string): DocLine[] {
  const block = parseBlock(user, 'retrieved_docs')
  if (!block) return []
  return block
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as DocLine)
}

export function createMockLlmClient(): { client: LlmClient; state: MockLlmState } {
  const state: MockLlmState = { nextRawText: null, nextDecisionMutator: null, delayMs: 0, calls: 0 }

  const client: LlmClient = {
    async complete(prompt: LlmPrompt, opts): Promise<LlmResponse> {
      state.calls += 1
      if (state.delayMs > 0) {
        const delay = state.delayMs
        state.delayMs = 0
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delay)
          opts.signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new LlmError('aborted', false))
          }, { once: true })
        })
      }
      if (opts.signal.aborted) throw new LlmError('aborted', false)

      if (state.nextRawText !== null) {
        const text = state.nextRawText
        state.nextRawText = null
        return { text, usage: { promptTokens: 500, completionTokens: 60 }, model: 'mock-1' }
      }

      const intent = parseBlock(prompt.user, 'intent_hint') || 'unknown'
      const message = parseBlock(prompt.user, 'customer_message')
      const docs = parseDocs(prompt.user)
      const phone = /01[3-9]\d{8}/.exec(message)?.[0] ?? null
      const qty = /(\d+)\s*(ta|pcs|piece|khana)/i.exec(message)?.[1]

      const factual = ['price_question', 'availability_question', 'delivery_question', 'size_or_color_question', 'product_search'].includes(intent)
      const handoverIntents = ['complaint', 'human_request', 'payment_question', 'unknown']

      let decision: Record<string, unknown>
      if (handoverIntents.includes(intent)) {
        decision = {
          intent, confidence: intent === 'unknown' ? 0.3 : 0.9, action: 'handover', reply: null,
          extracted: { name: null, phone, address: null, zone: null, productId: null, variantSku: null, quantity: null },
          sourceIds: [], handoverReason: intent,
        }
      } else if (intent === 'greeting') {
        decision = {
          intent, confidence: 0.95, action: 'reply',
          reply: 'Assalamu alaikum! Kivabe help korte pari?',
          extracted: { name: null, phone: null, address: null, zone: null, productId: null, variantSku: null, quantity: null },
          sourceIds: [], handoverReason: null,
        }
      } else if (intent === 'order_start' || intent === 'provide_customer_detail' || intent === 'order_confirmation') {
        const doc = docs[0]
        decision = {
          intent, confidence: 0.85,
          action: intent === 'order_confirmation' ? 'draft_order' : 'ask',
          reply: intent === 'order_confirmation'
            ? 'Order confirm korchi. Dhonnobad!'
            : phone ? 'Address ta bolben please?' : 'Apnar phone number ta den please.',
          extracted: {
            name: null, phone, address: null, zone: null,
            productId: doc?.id ?? null, variantSku: null,
            quantity: qty ? Number(qty) : null,
          },
          sourceIds: doc ? [doc.id] : [], handoverReason: null,
        }
      } else if (factual) {
        if (docs.length === 0) {
          // Well-aligned: nothing retrieved → cannot state facts.
          decision = {
            intent, confidence: 0.8, action: 'handover', reply: null,
            extracted: { name: null, phone: null, address: null, zone: null, productId: null, variantSku: null, quantity: null },
            sourceIds: [], handoverReason: 'no grounding documents',
          }
        } else {
          const doc = docs[0]!
          const reply = doc.priceTaka !== null
            ? `${doc.name} er dam ৳${doc.priceTaka}. ${doc.available !== null && doc.available > 0 ? 'Stock e ache!' : ''}`.trim()
            : doc.text.slice(0, 300)
          decision = {
            intent, confidence: 0.9, action: 'reply', reply,
            extracted: { name: null, phone: null, address: null, zone: null, productId: doc.type === 'product' ? doc.id : null, variantSku: null, quantity: null },
            sourceIds: [doc.id], handoverReason: null,
          }
        }
      } else {
        decision = {
          intent: 'unknown', confidence: 0.3, action: 'handover', reply: null,
          extracted: { name: null, phone: null, address: null, zone: null, productId: null, variantSku: null, quantity: null },
          sourceIds: [], handoverReason: 'unclassified',
        }
      }

      if (state.nextDecisionMutator) {
        state.nextDecisionMutator(decision)
        state.nextDecisionMutator = null
      }
      return {
        text: JSON.stringify(decision),
        usage: { promptTokens: Math.ceil(prompt.user.length / 4), completionTokens: 80 },
        model: 'mock-1',
      }
    },
  }
  return { client, state }
}
