/**
 * retentionPurger (§13.2 row 8, P-11) — the resumable, idempotent 90-day
 * cascade. Daily at 03:00 Dhaka under the Redis job lock.
 *
 * Resumability is BY CONSTRUCTION, not by a progress table:
 *   - every phase deletes in batches of `batchSize` ordered by _id;
 *   - every batch is an independent idempotent delete — a crash mid-run
 *     leaves strictly less work, and a re-run finds exactly the remainder;
 *   - the phase order (children before parents, workspace doc LAST) means no
 *     intermediate state has a dangling reference (architecture.md §12.11).
 *
 * // OPEN QUESTION: architecture.md §12.11 sketches a `purgeJobs` progress
 * // document, but prompt.md §5.1 fixes the inventory at EXACTLY 19
 * // collections and purgeJobs is not one of them. Narrow resolution: no new
 * // collection; resumability comes from phase order + idempotent batches
 * // (the P-11 test — interrupt and re-run → no orphans, no double-deletes —
 * // passes without it). Flagged, not silently decided.
 *
 * Tenancy: every query runs with skipTenancy under the allowlisted
 * 'retentionPurger' caller — one of the four §5.4 bypasses.
 */
import { createHash } from 'node:crypto'
import type { Types } from 'mongoose'
import {
  AuditLog, ChannelConnection, Conversation, Customer, Import,
  KnowledgeItem, Membership, Message, Order, Product, Session,
  StockReservation, UsageLedger, User, Workspace,
} from './models/index.js'

const DAY_MS = 86_400_000
const skipTenancyAsPurger = { skipTenancy: true, tenancyBypassCaller: 'retentionPurger' } as const

export interface PurgeReport {
  workspacesPurged: number
  conversationsPurged: number
  messagesPurged: number
  ordersPurged: number
  reservationsPurged: number
  customersAnonymised: number
  importsPurged: number
  usageLedgersPurged: number
  usersPurged: number
  batches: number
}

export interface PurgeOptions {
  batchSize?: number
  /** Upper bound on total batches per run — the daily run resumes tomorrow. */
  maxBatches?: number
  now?: Date
  /** Test hook: called after every completed batch (crash-injection point). */
  onBatch?: (phase: string, count: number) => void | Promise<void>
}

interface HasId { _id: Types.ObjectId }

/** Batch-delete by a filter, _id-ordered, until empty or budget exhausted. */
async function batchDelete(
  model: { find: (f: Record<string, unknown>) => unknown; deleteMany: (f: Record<string, unknown>) => unknown },
  filter: Record<string, unknown>,
  state: { batches: number; maxBatches: number; batchSize: number; onBatch?: PurgeOptions['onBatch'] },
  phase: string,
): Promise<number> {
  let total = 0
  while (state.batches < state.maxBatches) {
    const query = model.find(filter) as {
      sort: (s: Record<string, 1>) => { limit: (n: number) => { select: (s: string) => { setOptions: (o: object) => { exec: () => Promise<HasId[]> } } } }
    }
    const batch = await query.sort({ _id: 1 }).limit(state.batchSize).select('_id').setOptions(skipTenancyAsPurger).exec()
    if (batch.length === 0) break
    const ids = batch.map((d) => d._id)
    const del = model.deleteMany({ _id: { $in: ids } }) as { setOptions: (o: object) => { exec: () => Promise<{ deletedCount: number }> } }
    const res = await del.setOptions(skipTenancyAsPurger).exec()
    total += res.deletedCount
    state.batches += 1
    await state.onBatch?.(phase, res.deletedCount)
    if (batch.length < state.batchSize) break
  }
  return total
}

/**
 * The full workspace cascade — §12.11's exact phase order. Children first,
 * the workspace doc last: no intermediate crash leaves a dangling reference.
 * orderCounters survive deliberately (§5.1: permanent).
 */
async function purgeWorkspaceCascade(
  workspaceId: Types.ObjectId,
  state: { batches: number; maxBatches: number; batchSize: number; onBatch?: PurgeOptions['onBatch'] },
): Promise<boolean> {
  const ws = { workspaceId }
  // §12.11 phase order, verbatim.
  await batchDelete(Message, ws, state, 'ws:messages')
  await batchDelete(Conversation, ws, state, 'ws:conversations')
  await batchDelete(Order, ws, state, 'ws:orders')
  await batchDelete(StockReservation, ws, state, 'ws:stockReservations')
  await batchDelete(Customer, ws, state, 'ws:customers')
  await batchDelete(Product, ws, state, 'ws:products')
  await batchDelete(KnowledgeItem, ws, state, 'ws:knowledgeItems')
  await batchDelete(ChannelConnection, ws, state, 'ws:channelConnections')
  await batchDelete(Import, ws, state, 'ws:imports')
  await batchDelete(AuditLog, ws, state, 'ws:auditLogs')
  await batchDelete(Membership, ws, state, 'ws:memberships')
  // Not in the §12.11 list but tenant-owned with no independent retention:
  // invitations (TTL 7 d) and usageLedger (13 months) expire on their own.
  if (state.batches >= state.maxBatches) return false // resume tomorrow
  await Workspace.deleteOne({ _id: workspaceId }).exec()
  state.batches += 1
  await state.onBatch?.('ws:workspace', 1)
  return true
}

export async function runRetentionPurge(opts: PurgeOptions = {}): Promise<PurgeReport> {
  const now = opts.now ?? new Date()
  const state = {
    batches: 0,
    maxBatches: opts.maxBatches ?? 1000,
    batchSize: opts.batchSize ?? 500,
    ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
  }
  const report: PurgeReport = {
    workspacesPurged: 0, conversationsPurged: 0, messagesPurged: 0,
    ordersPurged: 0, reservationsPurged: 0, customersAnonymised: 0,
    importsPurged: 0, usageLedgersPurged: 0, usersPurged: 0, batches: 0,
  }

  // ── 1. Whole-workspace cascades (deactivation + 90 d) ─────────────────────
  const deadWorkspaces = await Workspace.find({
    status: { $in: ['deactivated', 'pending_deletion'] },
    purgeAfter: { $ne: null, $lt: now },
  }).select('_id').limit(10).exec()
  for (const ws of deadWorkspaces) {
    if (state.batches >= state.maxBatches) break
    const done = await purgeWorkspaceCascade(ws._id, state)
    if (done) report.workspacesPurged += 1
  }

  // ── 2. Row-level retention inside LIVE workspaces ─────────────────────────
  // Conversations (90 d): messages first — a crash between the two leaves
  // messages gone + conversation present (re-run finishes it), never orphan
  // messages pointing at a purged conversation being re-created.
  while (state.batches < state.maxBatches) {
    const convs = await Conversation.find({ purgeAfter: { $lt: now } }).setOptions(skipTenancyAsPurger)
      .sort({ _id: 1 }).limit(state.batchSize).select('_id').exec()
    if (convs.length === 0) break
    const convIds = convs.map((c) => c._id)
    const delMsgs = await Message.deleteMany({ conversationId: { $in: convIds } })
      .setOptions(skipTenancyAsPurger).exec()
    const delConvs = await Conversation.deleteMany({ _id: { $in: convIds } })
      .setOptions(skipTenancyAsPurger).exec()
    report.messagesPurged += delMsgs.deletedCount
    report.conversationsPurged += delConvs.deletedCount
    state.batches += 1
    await state.onBatch?.('rows:conversations', delConvs.deletedCount)
    if (convs.length < state.batchSize) break
  }

  // Orders (90 d): reservations for the batch first, then the orders.
  while (state.batches < state.maxBatches) {
    const orders = await Order.find({ purgeAfter: { $lt: now } }).setOptions(skipTenancyAsPurger)
      .sort({ _id: 1 }).limit(state.batchSize).select('_id').exec()
    if (orders.length === 0) break
    const orderIds = orders.map((o) => o._id)
    const delRes = await StockReservation.deleteMany({ orderId: { $in: orderIds } })
      .setOptions(skipTenancyAsPurger).exec()
    const delOrders = await Order.deleteMany({ _id: { $in: orderIds } })
      .setOptions(skipTenancyAsPurger).exec()
    report.reservationsPurged += delRes.deletedCount
    report.ordersPurged += delOrders.deletedCount
    state.batches += 1
    await state.onBatch?.('rows:orders', delOrders.deletedCount)
    if (orders.length < state.batchSize) break
  }

  // Customers (90 d inactive): ANONYMISE, never delete — order history rides
  // on the row. phoneHash survives (repeat-customer + fraud logic, §15.2).
  while (state.batches < state.maxBatches) {
    const stale = await Customer.find({
      lastSeenAt: { $lt: new Date(now.getTime() - 90 * DAY_MS) },
      anonymizedAt: null,
    }).setOptions(skipTenancyAsPurger).sort({ _id: 1 }).limit(state.batchSize).select('_id').exec()
    if (stale.length === 0) break
    for (const c of stale) {
      const hash = createHash('sha256').update(String(c._id)).digest('hex').slice(0, 8)
      await Customer.updateOne(
        { _id: c._id, anonymizedAt: null }, // idempotent — a re-run skips done rows
        {
          $set: {
            displayName: `Deleted Customer #${hash}`, // PRD §15.2 wording
            phone: null, addressText: null, notes: null,
            profilePicUrl: null, anonymizedAt: now,
          },
        },
      ).setOptions(skipTenancyAsPurger).exec()
      report.customersAnonymised += 1
    }
    state.batches += 1
    await state.onBatch?.('rows:customers', stale.length)
    if (stale.length < state.batchSize) break
  }

  // Imports (30 d — §5.1 row 19).
  report.importsPurged += await batchDelete(
    Import, { createdAt: { $lt: new Date(now.getTime() - 30 * DAY_MS) } }, state, 'rows:imports',
  )

  // usageLedger (13 months — §5.1 row 17): periodKey is sortable YYYY-MM.
  const cutoff = new Date(now.getTime())
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 13)
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`
  report.usageLedgersPurged += await batchDelete(
    UsageLedger, { periodKey: { $lt: cutoffKey } }, state, 'rows:usageLedger',
  )

  // Users (deactivated + 90 d): sessions die first, then the account doc.
  // Memberships were tombstoned at deactivation; audit rows keep the actorId
  // string. // OPEN QUESTION: no spec section details the user-purge cascade
  // — narrow behaviour: only users who own NO workspace are deleted.
  const deadUsers = await User.find({
    status: 'pending_deletion', purgeAfter: { $ne: null, $lt: now },
  }).select('_id').limit(100).exec()
  for (const u of deadUsers) {
    const owns = await Workspace.countDocuments({ ownerId: u._id }).exec()
    if (owns > 0) continue // owner must transfer or the workspace purges first
    await Session.deleteMany({ userId: u._id }).exec()
    await Membership.deleteMany({ userId: u._id })
      .setOptions(skipTenancyAsPurger).exec()
    await User.deleteOne({ _id: u._id }).exec()
    report.usersPurged += 1
  }

  report.batches = state.batches
  return report
}
