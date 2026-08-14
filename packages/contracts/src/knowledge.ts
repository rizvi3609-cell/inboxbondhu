import { z } from 'zod'
import { isoDate, objectIdString } from './common.js'

// ─── knowledgeItems (D11) ────────────────────────────────────────────────────

export const knowledgeStatus = z.enum(['draft', 'approved', 'archived']) // AI reads 'approved' only
export const knowledgeCategory = z.enum(['delivery', 'payment', 'return', 'sizing', 'general'])

/**
 * DB-layer document schema. NOTE (deliberate, do not harmonise):
 * `answer` is ≤ 2000 here (database) but ≤ 500 at the API edge — an LLM
 * context-budget control, not a schema error. See KnowledgeItemAnswerApi below.
 */
export const KnowledgeItemDoc = z
  .object({
    workspaceId: objectIdString,
    question: z.string().min(5).max(500),
    answer: z.string().min(5).max(2000),
    category: knowledgeCategory.nullish(),
    keywords: z.array(z.string().toLowerCase()).max(20).default([]),
    status: knowledgeStatus.default('draft'),
    searchText: z.string().default(''), // question + answer + keywords, pre-save hook
    usageCount: z.number().int().min(0).default(0),
    lastUsedAt: isoDate.nullish(),
    createdBy: objectIdString.nullish(),
    approvedBy: objectIdString.nullish(),
    version: z.number().int().min(0).default(0),
  })
  .strict()
export type KnowledgeItemDoc = z.infer<typeof KnowledgeItemDoc>

/** API-edge cap for `answer` — 500 chars (PRD §2.6). Used by Phase 5 routes. */
export const KnowledgeItemAnswerApi = z.string().min(5).max(500)
