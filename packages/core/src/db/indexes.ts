import mongoose from 'mongoose'
import * as models from './models/index.js'

/**
 * All indexes are DECLARED on the schemas (named I01…I59) and created here
 * idempotently via syncIndexes(). `assertIndexes()` is the boot gate: a
 * missing required index refuses to start with one clear line
 * (prompt.md §4 boot assertions).
 *
 * The four deliberate GLOBAL (non-tenant-prefixed) indexes — complete
 * allowlist, nothing else may be global:
 *   1. channelConnections {provider, externalPageId}   (ADR-013)
 *   2. webhookEvents      {dedupeKey}
 *   3. outboxEvents       {idempotencyKey}
 *   4. sessions           {refreshTokenHash}
 */
export const GLOBAL_INDEX_ALLOWLIST = [
  'channelConnections:I18',
  'webhookEvents:I48',
  'outboxEvents:I52',
  'sessions:I04',
] as const

/**
 * OPEN QUESTION: database.md §4.2 catalogues I15 `invitations {tokenHash}` as
 * U with no workspaceId prefix (accept-link resolution — the tenant is unknown
 * until the token resolves), but §4.6's "complete allowlist" of global indexes
 * lists only four and omits it. The catalogue is the field-level authority, so
 * the index is created as specified; it is tracked here separately rather than
 * silently widening the four-item allowlist. Raise before Phase 2 ships invite
 * acceptance.
 */
export const CATALOGUE_GLOBAL_UNIQUES_PENDING_DECISION = ['invitations:I15'] as const

const ALL_MODELS = [
  models.User,
  models.Session,
  models.Workspace,
  models.Membership,
  models.Invitation,
  models.ChannelConnection,
  models.Customer,
  models.Conversation,
  models.Message,
  models.Product,
  models.KnowledgeItem,
  models.Order,
  models.OrderCounter,
  models.StockReservation,
  models.WebhookEvent,
  models.OutboxEvent,
  models.UsageLedger,
  models.AuditLog,
  models.Import,
] as const

/** Idempotent creation — safe to run twice. */
export async function createIndexes(): Promise<void> {
  for (const model of ALL_MODELS) {
    await model.createCollection().catch((err: unknown) => {
      // NamespaceExists is fine — idempotent.
      if ((err as { codeName?: string }).codeName !== 'NamespaceExists') throw err
    })
    await model.syncIndexes()
  }
}

/** Every named index the schemas declare, per collection. */
async function declaredIndexNames(model: mongoose.Model<unknown>): Promise<string[]> {
  const specs = model.schema.indexes()
  return specs.map((spec) => {
    const opts = spec[1] as { name?: string }
    return opts.name ?? JSON.stringify(spec[0])
  })
}

export interface IndexAssertionFailure {
  collection: string
  missing: string[]
}

/**
 * Boot assertion: every declared index must exist. Returns failures instead of
 * throwing so the boot sequence can print ONE clear line and exit non-zero.
 */
export async function assertIndexes(): Promise<IndexAssertionFailure[]> {
  const failures: IndexAssertionFailure[] = []
  for (const model of ALL_MODELS) {
    const wanted = await declaredIndexNames(model as unknown as mongoose.Model<unknown>)
    const existing = (await model.collection.indexes()).map((ix) => ix.name)
    const missing = wanted.filter((name) => !existing.includes(name))
    if (missing.length > 0) {
      failures.push({ collection: model.collection.collectionName, missing })
    }
  }
  return failures
}

/**
 * CI guard: verify no schema declares a global (non-workspaceId-prefixed)
 * index on a tenant-scoped collection outside the four-item allowlist.
 */
export function auditGlobalIndexes(): string[] {
  const TENANT_EXEMPT = new Set(['users', 'sessions', 'workspaces', 'webhookEvents'])
  const violations: string[] = []
  for (const model of ALL_MODELS) {
    const collection = model.collection.collectionName
    for (const spec of model.schema.indexes()) {
      const keys = Object.keys(spec[0] as Record<string, unknown>)
      const opts = spec[1] as { name?: string; expireAfterSeconds?: number }
      const name = opts.name ?? JSON.stringify(spec[0])
      const id = `${collection}:${name}`
      const isGlobal = keys[0] !== 'workspaceId'
      if (!isGlobal) continue
      if ((GLOBAL_INDEX_ALLOWLIST as readonly string[]).includes(id)) continue
      if ((CATALOGUE_GLOBAL_UNIQUES_PENDING_DECISION as readonly string[]).includes(id)) continue
      if (TENANT_EXEMPT.has(collection)) continue
      // Operational sweeps (TTL, partial status sweeps, purgeAfter, requestId,
      // conversationId thread key) are documented in database.md §4.2 as
      // intentionally non-tenant-prefixed but NOT "global uniqueness" indexes.
      const isUnique = (spec[1] as { unique?: boolean }).unique === true
      if (!isUnique) continue
      violations.push(id)
    }
  }
  return violations
}
