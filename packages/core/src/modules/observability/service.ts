/**
 * MOD-12 observability — analytics summaries (Dhaka-day bucketed, per §6
 * aggregation rules: leading tenant $match always), the audit-log query API,
 * and the nightly stock reconciliation (the oversell detector, §6.6 —
 * DB-unenforceable rule #1's independent verifier).
 */
import mongoose from 'mongoose'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { AuditLog, Conversation, Message, Order, Product, StockReservation } from '../../db/models/index.js'

const DHAKA_TZ = '+06:00'

export class ObservabilityService {
  /** #66 GET /analytics/summary — viewer. */
  async summary(ctx: TenantContext, from: Date, to: Date) {
    const wsId = new mongoose.Types.ObjectId(ctx.workspaceId)
    const [conversations, aiStats, orders] = await Promise.all([
      Conversation.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to } } }, // I24 family
        { $group: { _id: null, total: { $sum: 1 }, ai: { $sum: { $cond: [{ $eq: ['$mode', 'ai'] }, 1, 0] } } } },
      ]),
      Message.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to }, 'author.type': 'ai' } }, // I31
        {
          $group: {
            _id: null,
            aiReplies: { $sum: 1 },
            avgLatencyMs: { $avg: '$aiMeta.latencyMs' },
            costMinor: { $sum: '$aiMeta.costMinor' },
            blocked: { $sum: { $cond: ['$aiMeta.groundingBlocked', 1, 0] } },
          },
        },
      ]),
      Order.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to } } }, // I40
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            confirmed: { $sum: { $cond: [{ $ne: ['$confirmedAt', null] }, 1, 0] } },
            revenueMinor: { $sum: { $cond: [{ $in: ['$fulfillmentStatus', ['Confirmed', 'Processing', 'Shipped', 'Delivered']] }, '$totalMinor', 0] } },
          },
        },
      ]),
    ])
    const conv = (conversations[0] as { total?: number; ai?: number } | undefined) ?? {}
    const ai = (aiStats[0] as { aiReplies?: number; avgLatencyMs?: number; costMinor?: number; blocked?: number } | undefined) ?? {}
    const ord = (orders[0] as { total?: number; confirmed?: number; revenueMinor?: number } | undefined) ?? {}
    return Result.ok({
      conversations: { total: conv.total ?? 0, aiHandled: conv.ai ?? 0 },
      ai: {
        replies: ai.aiReplies ?? 0,
        avgLatencyMs: Math.round(ai.avgLatencyMs ?? 0),
        costMinor: ai.costMinor ?? 0,
        groundingBlocked: ai.blocked ?? 0,
      },
      orders: {
        total: ord.total ?? 0,
        confirmed: ord.confirmed ?? 0,
        revenueMinor: ord.revenueMinor ?? 0,
        // The PRIMARY metric (PRD §1.5): confirmed ÷ total conversations.
        conversionPercent: (conv.total ?? 0) === 0 ? 0 : Math.round(((ord.confirmed ?? 0) / conv.total!) * 100),
      },
    })
  }

  /** #67 GET /analytics/timeseries — Dhaka-day bucketed. */
  async timeseries(ctx: TenantContext, metric: 'conversations' | 'orders' | 'ai_replies', from: Date, to: Date) {
    const wsId = new mongoose.Types.ObjectId(ctx.workspaceId)
    const dayBucket = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: DHAKA_TZ } }
    let rows: Array<{ _id: string; count: number }>
    if (metric === 'conversations') {
      rows = await Conversation.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: dayBucket, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
    } else if (metric === 'orders') {
      rows = await Order.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to } } },
        { $group: { _id: dayBucket, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
    } else {
      rows = await Message.aggregate([
        { $match: { workspaceId: wsId, createdAt: { $gte: from, $lte: to }, 'author.type': 'ai' } },
        { $group: { _id: dayBucket, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
    }
    return Result.ok({ metric, points: rows.map((r) => ({ day: r._id, count: r.count })) })
  }

  /** #74 GET /audit-logs — admin; filters actor/action/entity/date (PRD §2.11). */
  async auditLogs(
    ctx: TenantContext,
    query: { actorId?: string; action?: string; resourceType?: string; from?: Date; to?: Date; cursor?: string; limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100)
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId }
    if (query.actorId) filter['actorId'] = query.actorId
    if (query.action) filter['action'] = { $regex: `^${query.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
    if (query.resourceType) filter['resourceType'] = query.resourceType
    if (query.from || query.to) {
      filter['createdAt'] = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) }
    }
    if (query.cursor) filter['_id'] = { $lt: new mongoose.Types.ObjectId(query.cursor) }
    const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).exec() // I57/I58
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return Result.ok({
      logs: page.map((a) => ({
        id: String(a._id), actorId: a.actorId, actorType: a.actorType, actorRole: a.actorRole,
        action: a.action, resourceType: a.resourceType, resourceId: a.resourceId,
        before: a.before, after: a.after, requestId: a.requestId,
        createdAt: (a as unknown as { createdAt: Date }).createdAt,
      })),
      nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
    })
  }
}

/**
 * Nightly stock reconciliation (§6.6) — the oversell DETECTOR. Compares
 * variants.reserved against the sum of held reservations; any mismatch is
 * `order.oversell_detected` (alert: ANY occurrence, §15.5). Detects drift
 * that slipped past T1 + the sweepers; never auto-corrects silently.
 */
export async function reconcileStock(): Promise<{ checked: number; mismatches: Array<{ productId: string; variantSku: string; reserved: number; held: number }> }> {
  const heldByVariant = await StockReservation.aggregate([
    { $match: { workspaceId: { $exists: true }, status: 'held' } }, // I47
    { $group: { _id: { productId: '$productId', variantSku: '$variantSku' }, held: { $sum: '$qty' } } },
  ]).option({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' } as never)

  const heldMap = new Map<string, number>()
  for (const row of heldByVariant as Array<{ _id: { productId: unknown; variantSku: string }; held: number }>) {
    heldMap.set(`${String(row._id.productId)}:${row._id.variantSku}`, row.held)
  }

  const mismatches: Array<{ productId: string; variantSku: string; reserved: number; held: number }> = []
  let checked = 0
  const products = await Product.find({ 'variants.reserved': { $gt: 0 } })
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' })
    .limit(2000)
    .exec()
  const seen = new Set<string>()
  for (const p of products) {
    for (const v of p.get('variants') as Array<{ sku: string; reserved: number; stock: number }>) {
      checked += 1
      const key = `${String(p._id)}:${v.sku}`
      seen.add(key)
      const held = heldMap.get(key) ?? 0
      if (v.reserved !== held || v.reserved > v.stock) {
        mismatches.push({ productId: String(p._id), variantSku: v.sku, reserved: v.reserved, held })
      }
    }
  }
  // Reservations pointing at variants with reserved: 0 are also drift.
  for (const [key, held] of heldMap) {
    if (!seen.has(key) && held > 0) {
      const [productId, variantSku] = key.split(':') as [string, string]
      mismatches.push({ productId, variantSku, reserved: 0, held })
    }
  }
  return { checked, mismatches }
}
