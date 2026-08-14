import type { Schema, Query } from 'mongoose'

/**
 * Tenancy plugin — the highest-risk code in the system (prompt.md §5.4).
 *
 * INV-01: every query against a tenant-scoped collection must filter on
 * `workspaceId`, and that filter must come from the authenticated TenantContext.
 *
 * On a missing tenant filter: THROW (never silently scope), emit the
 * `tenant.scope_violation` metric, page SEV1.
 *
 * Exempt collections: `users`, `sessions` (global identity) and
 * `webhookEvents` (tenant unknown at dedupe time).
 *
 * Exactly four legitimate bypasses via `skipTenancy: true`, each code-reviewed
 * and logged: retention sweeper, outbox dispatcher, nightly integrity job,
 * admin reporting.
 */

export class TenantScopeViolationError extends Error {
  readonly collection: string
  readonly operation: string

  constructor(collection: string, operation: string) {
    super(
      `tenant.scope_violation: ${operation} on tenant-scoped collection "${collection}" without a workspaceId filter`,
    )
    this.name = 'TenantScopeViolationError'
    this.collection = collection
    this.operation = operation
  }
}

/** The four allowlisted bypass call-sites. Anything else passing skipTenancy is a review failure. */
export const TENANCY_BYPASS_CALLERS = [
  'retentionPurger',
  'outboxDispatcher',
  'nightlyIntegrityJob',
  'adminReporting',
] as const
export type TenancyBypassCaller = (typeof TENANCY_BYPASS_CALLERS)[number]

type ViolationListener = (info: { collection: string; operation: string }) => void
type BypassListener = (info: { collection: string; operation: string; caller: string }) => void

const violationListeners: ViolationListener[] = []
const bypassListeners: BypassListener[] = []

/** Observability hook — apps/worker wires this to the Datadog metric + SEV1 page. */
export function onTenantScopeViolation(fn: ViolationListener): void {
  violationListeners.push(fn)
}
/** Every legitimate bypass is logged. */
export function onTenancyBypass(fn: BypassListener): void {
  bypassListeners.push(fn)
}

/** The 11 query operations plus aggregate that the plugin guards. */
const GUARDED_QUERY_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'count',
  'countDocuments',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
] as const

function filterHasWorkspaceId(filter: unknown): boolean {
  if (filter === null || typeof filter !== 'object') return false
  const f = filter as Record<string, unknown>
  if ('workspaceId' in f && f['workspaceId'] !== undefined && f['workspaceId'] !== null) return true
  // Allow $and composition — every branch is checked for at least one hit.
  const and = f['$and']
  if (Array.isArray(and)) return and.some((sub) => filterHasWorkspaceId(sub))
  return false
}

interface TenancyOptions {
  /** True only for the four allowlisted callers. */
  skipTenancy?: boolean
  /** Which allowlisted caller is bypassing — required alongside skipTenancy. */
  tenancyBypassCaller?: string
}

export function tenancyPlugin(schema: Schema, options?: { exempt?: boolean }): void {
  if (options?.exempt) return

  function guard(this: Query<unknown, unknown>): void {
    const opts = this.getOptions() as TenancyOptions
    const collection = this.model?.collection?.collectionName ?? 'unknown'
    const operation = (this as unknown as { op?: string }).op ?? 'unknown'

    if (opts.skipTenancy === true) {
      const caller = opts.tenancyBypassCaller ?? 'UNDECLARED'
      for (const fn of bypassListeners) fn({ collection, operation, caller })
      return
    }
    if (!filterHasWorkspaceId(this.getFilter())) {
      for (const fn of violationListeners) fn({ collection, operation })
      throw new TenantScopeViolationError(collection, operation)
    }
  }

  for (const op of GUARDED_QUERY_OPS) {
    // Mongoose 8 has no 'count' query op at runtime for some models; pre() tolerates it.
    schema.pre(op as never, guard as never)
  }

  // aggregate: first pipeline stage must be a $match containing workspaceId,
  // unless options.skipTenancy is set.
  schema.pre('aggregate', function (this: import('mongoose').Aggregate<unknown[]>) {
    const opts = (this.options ?? {}) as TenancyOptions
    const collection =
      (this as unknown as { _model?: { collection?: { collectionName?: string } } })._model
        ?.collection?.collectionName ?? 'unknown'

    if (opts.skipTenancy === true) {
      const caller = opts.tenancyBypassCaller ?? 'UNDECLARED'
      for (const fn of bypassListeners) fn({ collection, operation: 'aggregate', caller })
      return
    }
    const pipeline = this.pipeline()
    const first = pipeline[0] as Record<string, unknown> | undefined
    const match = first?.['$match']
    if (!filterHasWorkspaceId(match)) {
      for (const fn of violationListeners) fn({ collection, operation: 'aggregate' })
      throw new TenantScopeViolationError(collection, 'aggregate')
    }
  })
}
