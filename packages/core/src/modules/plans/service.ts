/**
 * MOD-11 plans — limits table, live checks, 80 % warning / 100 % soft block
 * (AI pauses, HUMAN REPLIES CONTINUE), hourly reconciler (Mongo is
 * authoritative; Redis is corrected, never the reverse — ADR-004/005).
 * Reactive module: never imported by domain modules (§5.1) — the AI pipeline
 * receives a QuotaChecker via dependency, not an import of this module.
 */
import { AppError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { DhakaTime } from '../../kernel/dhakaTime.js'
import { Conversation, OutboxEvent, Product, UsageLedger, Workspace } from '../../db/models/index.js'
// Hardcoding-audit fix: the limits table lives in contracts — ONE source for
// enforcement (here) and display (dashboard plan cards). Re-exported so all
// existing `import { PLAN_LIMITS } from plans` call sites stay valid.
import { PLAN_LIMITS } from '@inboxbondhu/contracts'

export { PLAN_LIMITS }

export interface QuotaStatus {
  plan: string
  periodKey: string
  conversationsUsed: number
  conversationsLimit: number
  usagePercent: number
  aiPaused: boolean // 100 % soft block — AI only
  warningLevel: 'none' | 'warn80' | 'blocked100'
}

export class PlansService {
  /** Live quota check — the AI pipeline consults this before spending. */
  async quotaStatus(workspaceId: string, now = new Date()): Promise<QuotaStatus> {
    const periodKey = DhakaTime.dhakaPeriodKey(now)
    const workspace = await Workspace.findOne({ _id: workspaceId }).exec()
    const plan = workspace?.plan ?? 'trial'
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS['trial']!
    const ledger = await UsageLedger.findOne({ workspaceId, periodKey }).exec()
    const used = ledger?.conversationsUsed ?? 0
    const limit = ledger?.conversationsLimit ?? limits.conversations
    const pct = limit === 0 ? 100 : Math.floor((used / limit) * 100)
    return {
      plan, periodKey,
      conversationsUsed: used,
      conversationsLimit: limit,
      usagePercent: pct,
      aiPaused: used >= limit, // soft block: AI pauses, humans continue
      warningLevel: used >= limit ? 'blocked100' : pct >= 80 ? 'warn80' : 'none',
    }
  }

  /**
   * Emit the 80 %/100 % warnings AT MOST ONCE per period per level —
   * warningsSentAt[] deduplicates alerts (D17).
   */
  async maybeWarn(workspaceId: string, now = new Date()): Promise<{ warned: 'none' | '80' | '100' }> {
    const status = await this.quotaStatus(workspaceId, now)
    if (status.warningLevel === 'none') return { warned: 'none' }

    const ledger = await UsageLedger.findOne({ workspaceId, periodKey: status.periodKey }).exec()
    const sentCount = (ledger?.warningsSentAt ?? []).length
    // Convention: first entry = 80 % notice, second = 100 % notice.
    const level = status.warningLevel === 'blocked100' ? '100' : '80'
    if ((level === '80' && sentCount >= 1) || (level === '100' && sentCount >= 2)) {
      return { warned: 'none' } // already sent for this level
    }
    await UsageLedger.updateOne(
      { workspaceId, periodKey: status.periodKey },
      { $push: { warningsSentAt: now } },
    ).exec()
    await OutboxEvent.create({
      workspaceId,
      type: level === '100' ? 'quota.blocked' : 'quota.warning',
      payload: { workspaceId, periodKey: status.periodKey, used: status.conversationsUsed, limit: status.conversationsLimit },
      idempotencyKey: `quota.${level}:${workspaceId}:${status.periodKey}`,
      nextAttemptAt: now,
    }).catch((err: { code?: number }) => {
      if (err.code !== 11000) throw err // duplicate = already queued, fine
    })
    return { warned: level }
  }

  /** #72 GET /plan — owner. */
  async getPlan(ctx: TenantContext): Promise<Result<Record<string, unknown>, AppError>> {
    if (ctx.role !== 'owner') return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Owner only.'))
    const status = await this.quotaStatus(ctx.workspaceId)
    const limits = PLAN_LIMITS[status.plan] ?? PLAN_LIMITS['trial']!
    const products = await Product.countDocuments({ workspaceId: ctx.workspaceId, status: { $ne: 'archived' } }).exec()
    return Result.ok({
      plan: status.plan,
      periodKey: status.periodKey,
      conversations: { used: status.conversationsUsed, limit: status.conversationsLimit },
      products: { used: products, limit: limits.products },
      aiPaused: status.aiPaused,
    })
  }

  /** #73 POST /plan/change — owner; limit snapshot does NOT rewrite history. */
  async changePlan(ctx: TenantContext, newPlan: 'trial' | 'starter' | 'growth'): Promise<Result<{ plan: string }, AppError>> {
    if (ctx.role !== 'owner') return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Owner only.'))
    const workspace = await Workspace.findOne({ _id: ctx.workspaceId }).exec()
    if (!workspace) return Result.err(new AppError('NOT_FOUND', 'Workspace not found.'))
    if (workspace.plan === newPlan) {
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', `Already on the ${newPlan} plan.`))
    }
    await Workspace.updateOne({ _id: ctx.workspaceId }, { $set: { plan: newPlan } }).exec()
    // Current period's conversationsLimit stays snapshotted (D17). The NEW
    // limit applies from the next period — but an UPGRADE unblocks AI now by
    // raising the limit going forward:
    const upgrade = (PLAN_LIMITS[newPlan]?.conversations ?? 0) > (PLAN_LIMITS[workspace.plan]?.conversations ?? 0)
    if (upgrade) {
      const periodKey = DhakaTime.dhakaPeriodKey(new Date())
      await UsageLedger.updateOne(
        { workspaceId: ctx.workspaceId, periodKey },
        { $set: { plan: newPlan, conversationsLimit: PLAN_LIMITS[newPlan]!.conversations } },
      ).exec()
      // OPEN QUESTION: D17 says the snapshot "does not rewrite history", but a
      // mid-month UPGRADE that leaves the seller blocked would make upgrading
      // pointless. Narrow choice: upgrades raise the current-period limit;
      // downgrades never lower it mid-period. Flagged.
    }
    return Result.ok({ plan: newPlan })
  }
}

/**
 * usageReconciler (hourly, §13.2): recompute usageLedger from conversations
 * (the source of truth) — countedForBilling + billingPeriodKey (I27b).
 * Corrects Mongo drift; Redis fast counters are corrected FROM this, never
 * the reverse.
 */
export async function reconcileUsage(periodKey?: string): Promise<{ reconciled: number }> {
  const period = periodKey ?? DhakaTime.dhakaPeriodKey(new Date())
  const counts = await Conversation.aggregate([
    { $match: { workspaceId: { $exists: true }, billingPeriodKey: period, countedForBilling: true } },
    { $group: { _id: '$workspaceId', used: { $sum: 1 } } },
  ]).option({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' } as never)

  let reconciled = 0
  for (const row of counts as Array<{ _id: unknown; used: number }>) {
    const res = await UsageLedger.updateOne(
      { workspaceId: row._id, periodKey: period },
      { $set: { conversationsUsed: row.used, reconciledAt: new Date() } },
    )
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'nightlyIntegrityJob' })
      .exec()
    if (res.modifiedCount > 0) reconciled += 1
  }
  return { reconciled }
}
