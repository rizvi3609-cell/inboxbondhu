/**
 * LLM integration — interface + errors. Same pattern as meta/: the client is
 * an interface so the pipeline and the eval suite run against the
 * deterministic mock, and the real OpenAI/Gemini client is a one-file swap.
 * The model has NO tool access — it returns text only (§10.6 rule 4).
 */

export interface LlmPrompt {
  system: string
  user: string
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
}

export interface LlmResponse {
  text: string
  usage: LlmUsage
  model: string
}

export class LlmError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'LlmError'
  }
}

export interface LlmClient {
  /** Aborts via signal — the pipeline's Deadline is the authority (INV-09). */
  complete(prompt: LlmPrompt, opts: { signal: AbortSignal; maxTokens: number }): Promise<LlmResponse>
}
