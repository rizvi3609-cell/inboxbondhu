/**
 * MOD-07 knowledge service — FAQ CRUD with the DELIBERATE 500-char answer cap
 * at the API edge (DB ceiling 2000 — an LLM context budget, agent.md gotcha
 * #7), approve flow, and the retrieval helper whose `status: 'approved'`
 * filter lives INSIDE the query (US-014: a draft answer can never reach a
 * customer; post-filtering is one refactor away from being dropped).
 */
import { AppError, VersionConflictError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { AuditLog, KnowledgeItem } from '../../db/models/index.js'

export interface KnowledgeInput {
  question: string
  answer: string // ≤ 500 enforced by the API-edge Zod schema
  category?: 'delivery' | 'payment' | 'return' | 'sizing' | 'general' | null
  keywords?: string[]
}

export class KnowledgeService {
  // ── #53 list — viewer ─────────────────────────────────────────────────────

  async list(
    ctx: TenantContext,
    query: { status?: 'draft' | 'approved' | 'archived'; category?: string; cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100)
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId }
    if (query.status) filter['status'] = query.status
    if (query.category) filter['category'] = query.category
    if (query.cursor) filter['_id'] = { $gt: query.cursor }

    const rows = await KnowledgeItem.find(filter).sort({ _id: 1 }).limit(limit + 1).exec() // I37b
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return Result.ok({
      items: page.map((k) => this.serialise(k)),
      nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
    })
  }

  // ── #54 create — starts draft, never approved ────────────────────────────

  async create(ctx: TenantContext, input: KnowledgeInput) {
    const item = await KnowledgeItem.create({
      workspaceId: ctx.workspaceId,
      question: input.question,
      answer: input.answer,
      category: input.category ?? null,
      keywords: input.keywords ?? [],
      status: 'draft', // approval is an explicit separate act
      createdBy: ctx.userId,
      searchText: ' ',
    })
    await this.audit(ctx, 'knowledge.created', String(item._id), null, { question: input.question })
    return Result.ok(this.serialise(item))
  }

  // ── #55 update — If-Match; ANY edit reverts approved → draft ────────────

  async update(
    ctx: TenantContext,
    itemId: string,
    expectedVersion: number,
    changes: Partial<KnowledgeInput>,
  ) {
    const item = await KnowledgeItem.findOne({ _id: itemId, workspaceId: ctx.workspaceId }).exec()
    if (!item) return Result.err(new AppError('NOT_FOUND', 'Knowledge item not found.'))
    if (item.version !== expectedVersion) {
      return Result.err(new VersionConflictError(item.version, Object.keys(changes)))
    }
    const before = { question: item.question, answer: item.answer, status: item.status }
    if (changes.question !== undefined) item.question = changes.question
    if (changes.answer !== undefined) item.answer = changes.answer
    if (changes.category !== undefined) item.category = changes.category ?? null
    if (changes.keywords !== undefined) item.set('keywords', changes.keywords)
    // Editing an approved answer un-approves it: the merchant must re-verify
    // what the AI is allowed to say (grounding is only as good as approval).
    if (item.status === 'approved' && (changes.question !== undefined || changes.answer !== undefined)) {
      item.status = 'draft'
      item.approvedBy = null
    }
    await item.save()
    await this.audit(ctx, 'knowledge.updated', itemId, before, changes as Record<string, unknown>)
    return Result.ok(this.serialise(item))
  }

  // ── #56 DELETE = archive ─────────────────────────────────────────────────

  async archive(ctx: TenantContext, itemId: string) {
    const res = await KnowledgeItem.updateOne(
      { _id: itemId, workspaceId: ctx.workspaceId, status: { $ne: 'archived' } },
      { $set: { status: 'archived' } },
    ).exec()
    if (res.matchedCount === 0) {
      const exists = await KnowledgeItem.findOne({ _id: itemId, workspaceId: ctx.workspaceId }).exec()
      if (!exists) return Result.err(new AppError('NOT_FOUND', 'Knowledge item not found.'))
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Item is already archived.'))
    }
    await this.audit(ctx, 'knowledge.archived', itemId, null, null)
    return Result.ok({ archived: true })
  }

  // ── #57 approve — the explicit gate (PRD §2.6) ───────────────────────────

  async approve(ctx: TenantContext, itemId: string) {
    const res = await KnowledgeItem.updateOne(
      { _id: itemId, workspaceId: ctx.workspaceId, status: 'draft' },
      { $set: { status: 'approved', approvedBy: ctx.userId } },
    ).exec()
    if (res.matchedCount === 0) {
      const exists = await KnowledgeItem.findOne({ _id: itemId, workspaceId: ctx.workspaceId }).exec()
      if (!exists) return Result.err(new AppError('NOT_FOUND', 'Knowledge item not found.'))
      return Result.err(new AppError('INVALID_STATE_TRANSITION', `Only draft items can be approved (currently ${exists.status}).`))
    }
    await this.audit(ctx, 'knowledge.approved', itemId, { status: 'draft' }, { status: 'approved' })
    return Result.ok({ approved: true })
  }

  private serialise(k: {
    _id: unknown; question: string; answer: string; category?: string | null
    status: string; usageCount: number; version: number; get(f: string): unknown
  }): Record<string, unknown> {
    return {
      id: String(k._id),
      question: k.question,
      answer: k.answer,
      category: k.category ?? null,
      keywords: k.get('keywords'),
      status: k.status,
      usageCount: k.usageCount,
      version: k.version,
    }
  }

  private async audit(ctx: TenantContext, action: string, resourceId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Promise<void> {
    await AuditLog.create({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action,
      resourceType: 'knowledgeItem',
      resourceId,
      before,
      after,
      requestId: ctx.requestId,
    })
  }
}

// ── AI retrieval helpers (consumed by Phase 6) ──────────────────────────────

/**
 * FAQ retrieval for the AI. The approved filter is INSIDE the query — a draft
 * or archived item is structurally unreachable, not filtered afterwards.
 */
export async function retrieveApprovedFaqs(
  workspaceId: string,
  searchQuery: string,
  limit = 3,
): Promise<Array<{ id: string; question: string; answer: string; score: number }>> {
  const rows = await KnowledgeItem.find(
    {
      workspaceId,
      status: 'approved', // inside the query — US-014
      $text: { $search: searchQuery }, // I37
    },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .exec()
  return rows
    .map((r) => ({
      id: String(r._id),
      question: r.question,
      answer: r.answer,
      score: (r as unknown as { get(k: string): number }).get('score'),
    }))
    .filter((r) => r.score >= 0.4) // drop below 0.4 (§10.3)
}
