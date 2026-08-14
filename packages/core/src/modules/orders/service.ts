/**
 * MOD-08 orders service — §11 in full. T1 VERBATIM (§11.4). The server
 * calculates all money (INV-04); the client never sends a total. Reservation
 * lifecycle per §11.5: every reserved/stock change pairs with its row change
 * in one transaction — never separable.
 */
import mongoose from 'mongoose'
import { AppError, VersionConflictError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { Money } from '../../kernel/money.js'
import { DhakaTime } from '../../kernel/dhakaTime.js'
import { withTx } from '../../db/withTx.js'
import {
  AuditLog, Conversation, Customer, Order, OrderCounter, OutboxEvent, Product, StockReservation, Workspace,
} from '../../db/models/index.js'
import {
  CANCEL_PROCESSING_ROLES, DISCOUNT_ROLES, canTransitionFulfillment, canTransitionPayment,
  type FulfillmentStatus, type PaymentStatus,
} from './stateMachine.js'
import type { IdempotencyStore } from '../inbox/service.js'

const DAY_MS = 86_400_000
const HOLD_HOURS = 24

export interface OrderItemInput {
  productId: string
  variantSku: string
  quantity: number
}

export interface CreateOrderInput {
  conversationId: string
  customerId: string
  items: OrderItemInput[]
  recipientName: string
  recipientPhone: string
  deliveryAddress: string
  deliveryZone: string
  discountPercent?: number
  paymentMethod?: 'cod' | 'bkash' | 'nagad' | 'rocket'
}

/** Server-side Dhaka-zone normaliser (PRD §2.9): Banglish variants → Dhaka. */
export function normaliseZone(raw: string, zones: Array<{ name: string }>): string {
  const t = raw.trim().toLowerCase()
  if (/^(dhaka|dkha|daka|dhaka city|dhk|ঢাকা)/.test(t)) {
    const dhaka = zones.find((z) => z.name.toLowerCase() === 'dhaka')
    if (dhaka) return dhaka.name
  }
  const exact = zones.find((z) => z.name.toLowerCase() === t)
  if (exact) return exact.name
  // Unrecognized cities fall back to "Outside Dhaka" when the workspace has it.
  const outside = zones.find((z) => /outside/i.test(z.name))
  return outside?.name ?? zones[0]?.name ?? raw
}


/** Structural order-document type for internal helpers (mongoose generics don't survive ReturnType). */
interface OrderDocLike {
  _id: unknown
  orderCode?: string | null
  conversationId: unknown
  customerId: unknown
  items: Array<{
    productId: unknown; variantSku: string; nameSnapshot: string
    variantNameSnapshot: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number
  }>
  subtotalMinor: number
  discountMinor: number
  discountPercent?: number | null
  deliveryFeeMinor: number
  totalMinor: number
  deliveryZone: string
  deliveryAddress: string
  recipientName: string
  recipientPhone: string
  fulfillmentStatus: string
  paymentStatus: string
  paymentMethod: string
  statusHistory: unknown
  version: number
}

export class OrdersService {
  constructor(private readonly idempotency: IdempotencyStore) {}

  // ── #58/#59 list + get ────────────────────────────────────────────────────

  async list(
    ctx: TenantContext,
    query: {
      fulfillmentStatus?: FulfillmentStatus
      paymentStatus?: PaymentStatus
      customerId?: string
      q?: string
      from?: Date
      to?: Date
      cursor?: string
      limit?: number
    } = {},
  ) {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100)
    const filter: Record<string, unknown> = { workspaceId: ctx.workspaceId }
    if (query.fulfillmentStatus) filter['fulfillmentStatus'] = query.fulfillmentStatus
    if (query.paymentStatus) filter['paymentStatus'] = query.paymentStatus
    if (query.customerId) filter['customerId'] = query.customerId
    if (query.q) filter['orderCode'] = { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } // I39
    if (query.from || query.to) {
      filter['createdAt'] = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      }
    }
    if (query.cursor) filter['_id'] = { $lt: new mongoose.Types.ObjectId(query.cursor) }

    const rows = await Order.find(filter).sort({ _id: -1 }).limit(limit + 1).exec() // I40 family
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    return Result.ok({
      orders: page.map((o) => this.serialise(o)),
      nextCursor: hasMore ? String(page[page.length - 1]!._id) : null,
    })
  }

  async get(ctx: TenantContext, orderId: string) {
    const order = await Order.findOne({ _id: orderId, workspaceId: ctx.workspaceId }).exec()
    if (!order) return Result.err(new AppError('NOT_FOUND', 'Order not found.'))
    return Result.ok(this.serialise(order))
  }

  // ── #60 POST /orders — manual creation, Idempotency-Key required ─────────

  async create(
    ctx: TenantContext,
    idempotencyKey: string,
    input: CreateOrderInput,
  ): Promise<Result<{ order: Record<string, unknown>; replayed: boolean }, AppError>> {
    // Carve-out: any request with discountPercent > 0 from an agent → 403.
    if ((input.discountPercent ?? 0) > 0 && !DISCOUNT_ROLES.has(ctx.role)) {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Only owners and admins may apply discounts.'))
    }

    const existing = await this.idempotency.claim(ctx.workspaceId, `order:${idempotencyKey}`)
    if (existing && existing !== 'PENDING') {
      const replayOrder = await Order.findOne({ _id: existing, workspaceId: ctx.workspaceId }).exec()
      if (replayOrder) return Result.ok({ order: this.serialise(replayOrder), replayed: true })
    }
    if (existing === 'PENDING') {
      return Result.err(new AppError('DUPLICATE_RESOURCE', 'This request is already being processed.'))
    }

    const built = await this.buildOrderFields(ctx, input)
    if (!built.ok) return built

    const conversation = await Conversation.findOne({ _id: input.conversationId, workspaceId: ctx.workspaceId }).exec()
    if (!conversation) return Result.err(new AppError('NOT_FOUND', 'Conversation not found.'))
    const customer = await Customer.findOne({ _id: input.customerId, workspaceId: ctx.workspaceId }).exec()
    if (!customer) return Result.err(new AppError('NOT_FOUND', 'Customer not found.'))

    const order = await Order.create({
      workspaceId: ctx.workspaceId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      ...built.value,
      fulfillmentStatus: 'AwaitingConfirmation', // manual orders arrive complete
      paymentMethod: input.paymentMethod ?? 'cod',
      createdByType: 'agent',
      draftLastTouchedAt: new Date(),
      statusHistory: [{
        from: 'Collecting', to: 'AwaitingConfirmation', at: new Date(),
        byType: 'agent', byUserId: new mongoose.Types.ObjectId(ctx.userId),
      }],
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })
    await this.idempotency.finalise(ctx.workspaceId, `order:${idempotencyKey}`, String(order._id))
    await this.audit(ctx, 'order.created', String(order._id), null, { itemCount: input.items.length })
    return Result.ok({ order: this.serialise(order), replayed: false })
  }

  /**
   * Snapshot items + server-calculated money. The client NEVER sends totals —
   * any totals in the request body were already stripped by the Zod contract.
   */
  private async buildOrderFields(ctx: TenantContext, input: CreateOrderInput) {
    if (input.items.length === 0) {
      return Result.err(new AppError('VALIDATION_FAILED', 'At least one item is required.'))
    }
    const workspace = await Workspace.findOne({ _id: ctx.workspaceId }).exec()
    if (!workspace) return Result.err(new AppError('NOT_FOUND', 'Workspace not found.'))

    const maxDiscount = workspace.aiConfig?.maxDiscountPercent ?? 50
    const discountPercent = input.discountPercent ?? 0
    if (discountPercent > maxDiscount || discountPercent > 50) {
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', `Discount above the ${Math.min(maxDiscount, 50)}% cap.`))
    }

    const items = []
    for (const line of input.items) {
      if (line.quantity < 1) {
        return Result.err(new AppError('BUSINESS_RULE_VIOLATION', 'Quantity must be at least 1.'))
      }
      const product = await Product.findOne({ _id: line.productId, workspaceId: ctx.workspaceId, status: 'active' }).exec()
      if (!product) return Result.err(new AppError('NOT_FOUND', `Product ${line.productId} not found or not active.`))
      const variant = (product.get('variants') as Array<{ sku: string; name: string; priceMinor?: number | null; stock: number; reserved: number }>)
        .find((v) => v.sku === line.variantSku)
      if (!variant) return Result.err(new AppError('NOT_FOUND', `Variant ${line.variantSku} not found.`))
      if (line.quantity > variant.stock - variant.reserved) {
        return Result.err(new AppError('BUSINESS_RULE_VIOLATION',
          `Only ${variant.stock - variant.reserved} of ${product.name} (${variant.sku}) available.`))
      }
      const unitPriceMinor = variant.priceMinor ?? product.basePriceMinor // snapshot at add-time
      items.push({
        productId: product._id,
        variantSku: variant.sku, // variants[].sku → items[].variantSku (DB-15)
        nameSnapshot: product.name,
        variantNameSnapshot: variant.name,
        unitPriceMinor,
        quantity: line.quantity,
        lineTotalMinor: Money.mulQty(unitPriceMinor, line.quantity),
      })
    }

    const zones = (workspace.get('deliveryZones') as Array<{ name: string; feeMinor: number }>) ?? []
    const zoneName = normaliseZone(input.deliveryZone, zones)
    const zone = zones.find((z) => z.name === zoneName)
    const deliveryFeeMinor = zone?.feeMinor ?? 0

    const subtotalMinor = items.reduce((sum, i) => Money.add(sum, i.lineTotalMinor), Money.of(0))
    const discountMinor = Money.floorPercent(subtotalMinor, discountPercent)
    const totalMinor = Money.add(Money.sub(subtotalMinor, discountMinor), deliveryFeeMinor)

    return Result.ok({
      items, subtotalMinor, discountMinor,
      discountPercent: discountPercent || null,
      deliveryFeeMinor, totalMinor,
      deliveryZone: zoneName,
      deliveryAddress: input.deliveryAddress,
      recipientName: input.recipientName,
      recipientPhone: input.recipientPhone,
    })
  }

  // ── #61 PATCH /orders/:id — If-Match; recalculate is the only money writer ─

  async update(
    ctx: TenantContext,
    orderId: string,
    expectedVersion: number,
    changes: {
      items?: OrderItemInput[]
      discountPercent?: number
      deliveryAddress?: string
      deliveryZone?: string
      recipientName?: string
      recipientPhone?: string
      paymentMethod?: 'cod' | 'bkash' | 'nagad' | 'rocket'
      fulfillmentStatus?: FulfillmentStatus
      paymentStatus?: PaymentStatus
    },
  ): Promise<Result<Record<string, unknown>, AppError>> {
    const order = await Order.findOne({ _id: orderId, workspaceId: ctx.workspaceId }).exec()
    if (!order) return Result.err(new AppError('NOT_FOUND', 'Order not found.'))
    if (order.version !== expectedVersion) {
      return Result.err(new VersionConflictError(order.version, Object.keys(changes)))
    }

    // Carve-out: applying or CHANGING a non-zero discount needs owner/admin.
    if (changes.discountPercent !== undefined && changes.discountPercent > 0 && !DISCOUNT_ROLES.has(ctx.role)) {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Only owners and admins may apply discounts.'))
    }

    // Fulfillment transition via the explicit map.
    if (changes.fulfillmentStatus && changes.fulfillmentStatus !== order.fulfillmentStatus) {
      const from = order.fulfillmentStatus as FulfillmentStatus
      const to = changes.fulfillmentStatus
      if (!canTransitionFulfillment(from, to)) {
        return Result.err(new AppError('INVALID_STATE_TRANSITION', `Cannot move ${from} → ${to}.`))
      }
      if (to === 'Cancelled') {
        return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Use POST /orders/:id/cancel to cancel.'))
      }
      if (to === 'Confirmed') {
        return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Use POST /orders/:id/confirm — confirmation reserves stock (T1).'))
      }
      if (to === 'Processing') return this.moveToProcessing(ctx, orderId, expectedVersion)
      // Shipped / Delivered — §8.7: agent+ may mark these. Customer notify via outbox (PRD §2.9).
      const result = await this.transition(ctx, order, to, null)
      if (!result.ok) return result
      return this.get(ctx, orderId).then((r) => (r.ok ? Result.ok(r.value) : r))
    }

    // Payment transition (COD cash recording: Unpaid → Paid at delivery).
    if (changes.paymentStatus && changes.paymentStatus !== order.paymentStatus) {
      const from = order.paymentStatus as PaymentStatus
      if (!canTransitionPayment(from, changes.paymentStatus)) {
        return Result.err(new AppError('INVALID_STATE_TRANSITION', `Cannot move payment ${from} → ${changes.paymentStatus}.`))
      }
      order.paymentStatus = changes.paymentStatus
    }

    // Detail/item edits only while the order is still mutable.
    const mutable = ['Collecting', 'AwaitingConfirmation'].includes(order.fulfillmentStatus)
    const editingDetails =
      changes.items !== undefined || changes.discountPercent !== undefined ||
      changes.deliveryAddress !== undefined || changes.deliveryZone !== undefined ||
      changes.recipientName !== undefined || changes.recipientPhone !== undefined
    if (editingDetails && !mutable) {
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Items and details are frozen after confirmation.'))
    }

    if (editingDetails) {
      const rebuilt = await this.buildOrderFields(ctx, {
        conversationId: String(order.conversationId),
        customerId: String(order.customerId),
        items: changes.items ?? order.items.map((i) => ({
          productId: String(i.productId), variantSku: i.variantSku, quantity: i.quantity,
        })),
        recipientName: changes.recipientName ?? order.recipientName,
        recipientPhone: changes.recipientPhone ?? order.recipientPhone,
        deliveryAddress: changes.deliveryAddress ?? order.deliveryAddress,
        deliveryZone: changes.deliveryZone ?? order.deliveryZone,
        discountPercent: changes.discountPercent ?? order.discountPercent ?? 0,
      })
      if (!rebuilt.ok) return rebuilt
      order.set('items', rebuilt.value.items)
      order.subtotalMinor = rebuilt.value.subtotalMinor
      order.discountMinor = rebuilt.value.discountMinor
      order.discountPercent = rebuilt.value.discountPercent
      order.deliveryFeeMinor = rebuilt.value.deliveryFeeMinor
      order.totalMinor = rebuilt.value.totalMinor
      order.deliveryZone = rebuilt.value.deliveryZone
      order.deliveryAddress = rebuilt.value.deliveryAddress
      order.recipientName = rebuilt.value.recipientName
      order.recipientPhone = rebuilt.value.recipientPhone
      order.draftLastTouchedAt = new Date()
    }
    if (changes.paymentMethod) order.paymentMethod = changes.paymentMethod

    await order.save() // occ plugin bumps version
    await this.audit(ctx, 'order.updated', orderId, null, changes as Record<string, unknown>)
    return Result.ok(this.serialise(order))
  }

  // ── #62 T1 — VERBATIM §11.4 ───────────────────────────────────────────────

  async confirm(ctx: TenantContext, orderId: string): Promise<Result<Record<string, unknown>, AppError>> {
    try {
      const confirmed = await withTx(async (session) => {
        const { workspaceId } = ctx
        const year = DhakaTime.dhakaYear(new Date())

        // 1. Claim the order via OCC. The conditional filter makes it safe under retry.
        const order = await Order.findOneAndUpdate(
          { _id: orderId, workspaceId, fulfillmentStatus: 'AwaitingConfirmation' },
          {
            $set: { fulfillmentStatus: 'Confirmed', confirmedAt: new Date() },
            $push: {
              statusHistory: {
                from: 'AwaitingConfirmation', to: 'Confirmed',
                at: new Date(), byType: 'agent', byUserId: new mongoose.Types.ObjectId(ctx.userId),
              },
            },
          },
          { new: true, session },
        )
        if (!order) {
          throw new AppError('INVALID_STATE_TRANSITION',
            'Order is not awaiting confirmation, or was already confirmed')
        }

        // 2. Assign the order number ONLY on first confirmation.
        if (!order.orderCode) {
          // T1 verbatim keys by the composite _id alone; the tenancy plugin
          // (rightly) demands an explicit workspaceId — the redundant stored
          // field exists precisely so this filter needs no string parsing.
          const counter = await OrderCounter.findOneAndUpdate(
            { _id: `${workspaceId}:${year}`, workspaceId },
            { $inc: { seq: 1 }, $setOnInsert: { year }, $set: { updatedAt: new Date() } },
            { upsert: true, new: true, session },
          )
          order.orderYear = year
          order.orderNumber = counter!.seq
          order.orderCode = `ORD-${year}-${String(counter!.seq).padStart(5, '0')}`
          await order.save({ session })
        }

        // 3. Reserve stock. The $expr filter IS the oversell guard.
        // GENUINE SPEC CONFLICT (reported): §11.4's verbatim snippet puts
        // $expr INSIDE $elemMatch, which MongoDB rejects ("$expr can only be
        // applied to the top-level document"). This is the semantically
        // identical legal form: a top-level $expr over the variants array
        // plus the positional match on sku. Check and decrement remain ONE
        // atomic operation on one document — the guarantee is unchanged.
        for (const item of order.items) {
          const res = await Product.updateOne(
            {
              _id: item.productId, workspaceId,
              'variants.sku': item.variantSku, // binds the positional $ below
              $expr: {
                $anyElementTrue: {
                  $map: {
                    input: '$variants',
                    as: 'v',
                    in: {
                      $and: [
                        { $eq: ['$$v.sku', item.variantSku] },
                        { $gte: [{ $subtract: ['$$v.stock', '$$v.reserved'] }, item.quantity] },
                      ],
                    },
                  },
                },
              },
            },
            { $inc: { 'variants.$.reserved': item.quantity, version: 1 } },
            { session },
          ).exec()
          if (res.matchedCount === 0) {
            throw new AppError('BUSINESS_RULE_VIOLATION',
              `Insufficient stock for ${item.nameSnapshot} (${item.variantSku})`)
          }

          await StockReservation.create([{
            workspaceId, orderId: order._id, productId: item.productId,
            variantSku: item.variantSku, qty: item.quantity,
            status: 'held', expiresAt: new Date(Date.now() + HOLD_HOURS * 3_600_000),
          }], { session })
        }

        // 4. Outbox — every external effect, dispatched after commit.
        await OutboxEvent.create([{
          workspaceId, type: 'order.confirmed',
          payload: {
            orderId: order._id, orderCode: order.orderCode,
            conversationId: order.conversationId, totalMinor: order.totalMinor,
          },
          idempotencyKey: `order.confirmed:${order._id}`, // globally unique → exactly once
          status: 'pending', attempts: 0, nextAttemptAt: new Date(),
        }], { session })

        // 5. Audit.
        await AuditLog.create([{
          workspaceId, actorId: ctx.userId, actorType: 'user',
          actorRole: ctx.role === 'system' ? null : ctx.role,
          action: 'order.confirmed', resourceType: 'order', resourceId: String(order._id),
          after: { fulfillmentStatus: 'Confirmed', orderCode: order.orderCode },
          requestId: ctx.requestId,
        }], { session })

        return order
      })
      return Result.ok(this.serialise(confirmed))
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
  }

  // ── #63 cancel — releases reservations (§11.5 row 2) ─────────────────────

  async cancel(
    ctx: TenantContext,
    orderId: string,
    reason: string,
  ): Promise<Result<Record<string, unknown>, AppError>> {
    try {
      const cancelled = await withTx(async (session) => {
        const order = await Order.findOne({ _id: orderId, workspaceId: ctx.workspaceId }).session(session).exec()
        if (!order) throw new AppError('NOT_FOUND', 'Order not found.')
        const from = order.fulfillmentStatus as FulfillmentStatus
        if (!canTransitionFulfillment(from, 'Cancelled')) {
          throw new AppError('INVALID_STATE_TRANSITION', `A ${from} order cannot be cancelled.`)
        }
        // Carve-out: Processing → Cancelled is owner/admin only, reason audited (PRD §2.9).
        if (from === 'Processing' && !CANCEL_PROCESSING_ROLES.has(ctx.role)) {
          throw new AppError('INSUFFICIENT_PERMISSIONS', 'Only owners and admins may cancel a processing order.')
        }

        // Release held reservations + decrement reserved — ONE transaction (I45).
        const holds = await StockReservation.find({
          workspaceId: ctx.workspaceId, orderId: order._id, status: 'held',
        }).session(session).exec()
        for (const hold of holds) {
          await Product.updateOne(
            { _id: hold.productId, workspaceId: ctx.workspaceId, 'variants.sku': hold.variantSku },
            { $inc: { 'variants.$.reserved': -hold.qty, version: 1 } },
            { session },
          ).exec()
          await StockReservation.updateOne(
            { _id: hold._id, workspaceId: ctx.workspaceId },
            { $set: { status: 'released', releasedAt: new Date() } },
            { session },
          ).exec()
        }
        // A cancel from AwaitingConfirmation has no reservation — a no-op, not an error.

        await Order.updateOne(
          { _id: order._id, workspaceId: ctx.workspaceId },
          {
            $set: { fulfillmentStatus: 'Cancelled', cancelledAt: new Date(), cancellationReason: reason },
            $push: {
              statusHistory: {
                from, to: 'Cancelled', at: new Date(),
                byType: ctx.role === 'system' ? 'system' : 'agent',
                ...(ctx.role !== 'system' ? { byUserId: new mongoose.Types.ObjectId(ctx.userId) } : {}),
                note: reason,
              },
            },
          },
          { session },
        ).exec()

        await AuditLog.create([{
          workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: ctx.role === 'system' ? 'system' : 'user',
          actorRole: ctx.role === 'system' ? null : ctx.role,
          action: 'order.cancelled', resourceType: 'order', resourceId: String(order._id),
          before: { fulfillmentStatus: from }, after: { fulfillmentStatus: 'Cancelled', reason },
          requestId: ctx.requestId,
        }], { session })

        return order
      })
      const fresh = await Order.findOne({ _id: cancelled._id, workspaceId: ctx.workspaceId }).exec()
      return Result.ok(this.serialise(fresh!))
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
  }

  // ── Confirmed → Processing: commit reservations (§11.5 row 3) ────────────

  private async moveToProcessing(
    ctx: TenantContext,
    orderId: string,
    expectedVersion: number,
  ): Promise<Result<Record<string, unknown>, AppError>> {
    try {
      await withTx(async (session) => {
        const order = await Order.findOneAndUpdate(
          { _id: orderId, workspaceId: ctx.workspaceId, fulfillmentStatus: 'Confirmed', version: expectedVersion },
          {
            $set: { fulfillmentStatus: 'Processing' },
            $inc: { version: 1 },
            $push: {
              statusHistory: {
                from: 'Confirmed', to: 'Processing', at: new Date(),
                byType: 'agent', byUserId: new mongoose.Types.ObjectId(ctx.userId),
              },
            },
          },
          { new: true, session },
        )
        if (!order) throw new AppError('INVALID_STATE_TRANSITION', 'Order is not in Confirmed state (or version is stale).')

        // Commit: reserved −qty AND stock −qty, row → committed. One transaction.
        const holds = await StockReservation.find({
          workspaceId: ctx.workspaceId, orderId: order._id, status: 'held',
        }).session(session).exec()
        for (const hold of holds) {
          await Product.updateOne(
            { _id: hold.productId, workspaceId: ctx.workspaceId, 'variants.sku': hold.variantSku },
            { $inc: { 'variants.$.reserved': -hold.qty, 'variants.$.stock': -hold.qty, version: 1 } },
            { session },
          ).exec()
          await StockReservation.updateOne(
            { _id: hold._id, workspaceId: ctx.workspaceId },
            { $set: { status: 'committed', committedAt: new Date() } },
            { session },
          ).exec()
        }

        await AuditLog.create([{
          workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: 'user',
          actorRole: ctx.role === 'system' ? null : ctx.role,
          action: 'order.processing', resourceType: 'order', resourceId: String(order._id),
          after: { fulfillmentStatus: 'Processing' }, requestId: ctx.requestId,
        }], { session })
      })
      return this.get(ctx, orderId).then((r) => (r.ok ? Result.ok(r.value) : r))
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
  }

  private async transition(
    ctx: TenantContext,
    order: OrderDocLike,
    to: FulfillmentStatus,
    note: string | null,
  ): Promise<Result<void, AppError>> {
    const from = order.fulfillmentStatus as FulfillmentStatus
    const res = await Order.updateOne(
      { _id: order._id, workspaceId: ctx.workspaceId, fulfillmentStatus: from, version: order.version },
      {
        $set: { fulfillmentStatus: to },
        $push: {
          statusHistory: {
            from, to, at: new Date(),
            byType: 'agent', byUserId: new mongoose.Types.ObjectId(ctx.userId),
            ...(note ? { note } : {}),
          },
        },
      },
    ).exec()
    if (res.matchedCount === 0) {
      const fresh = await Order.findOne({ _id: order._id, workspaceId: ctx.workspaceId }).exec()
      return Result.err(new VersionConflictError(fresh?.version ?? 0, ['fulfillmentStatus']))
    }
    // Customer notify on Shipped/Delivered (PRD §2.9) — via outbox, after commit path.
    if (to === 'Shipped' || to === 'Delivered') {
      await OutboxEvent.create({
        workspaceId: ctx.workspaceId, type: `order.${to.toLowerCase()}`,
        payload: { orderId: String(order._id), orderCode: order.orderCode, conversationId: String(order.conversationId) },
        idempotencyKey: `order.${to.toLowerCase()}:${String(order._id)}`,
        nextAttemptAt: new Date(),
      })
    }
    await this.audit(ctx, `order.${to.toLowerCase()}`, String(order._id), { fulfillmentStatus: from }, { fulfillmentStatus: to })
    return Result.ok(undefined)
  }

  private serialise(o: OrderDocLike): Record<string, unknown> {
    return {
      id: String(o._id),
      orderCode: o.orderCode ?? null,
      conversationId: String(o.conversationId),
      customerId: String(o.customerId),
      items: o.items.map((i) => ({
        productId: String(i.productId), variantSku: i.variantSku,
        nameSnapshot: i.nameSnapshot, variantNameSnapshot: i.variantNameSnapshot,
        unitPriceMinor: i.unitPriceMinor, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor,
      })),
      subtotalMinor: o.subtotalMinor,
      discountMinor: o.discountMinor,
      discountPercent: o.discountPercent ?? null,
      deliveryFeeMinor: o.deliveryFeeMinor,
      totalMinor: o.totalMinor,
      deliveryZone: o.deliveryZone,
      deliveryAddress: o.deliveryAddress,
      recipientName: o.recipientName,
      recipientPhone: o.recipientPhone,
      fulfillmentStatus: o.fulfillmentStatus,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      statusHistory: o.statusHistory,
      version: o.version,
    }
  }

  private async audit(
    ctx: TenantContext, action: string, resourceId: string,
    before: Record<string, unknown> | null, after: Record<string, unknown> | null,
  ): Promise<void> {
    await AuditLog.create({
      workspaceId: ctx.workspaceId, actorId: ctx.userId, actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action, resourceType: 'order', resourceId, before, after, requestId: ctx.requestId,
    })
  }
}

// ── Sweepers (§13.2 rows 2–3) ────────────────────────────────────────────────

/**
 * abandonedOrderSweeper (every 15 min): Collecting drafts untouched for 24 h
 * → Cancelled(system_abandoned), reservations released. Uses I42.
 */
export async function sweepAbandonedOrders(olderThanHours = 24): Promise<{ cancelled: number }> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000)
  const stale = await Order.find({
    fulfillmentStatus: 'Collecting',
    draftLastTouchedAt: { $lt: cutoff },
  })
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' })
    .limit(200)
    .exec()

  let cancelled = 0
  for (const order of stale) {
    await withTx(async (session) => {
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, fulfillmentStatus: 'Collecting' },
        {
          $set: { fulfillmentStatus: 'Cancelled', cancelledAt: new Date(), cancellationReason: 'system_abandoned' },
          $inc: { version: 1 },
          $push: { statusHistory: { from: 'Collecting', to: 'Cancelled', at: new Date(), byType: 'system', note: 'system_abandoned' } },
        },
        { new: true, session },
      )
        .setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' })
        .exec()
      if (!claimed) return
      // Collecting drafts hold no reservations (T1 not run) — release defensively anyway.
      const holds = await StockReservation.find({ orderId: claimed._id, status: 'held' })
        .setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' })
        .session(session)
        .exec()
      for (const hold of holds) {
        await Product.updateOne(
          { _id: hold.productId, workspaceId: hold.workspaceId, 'variants.sku': hold.variantSku },
          { $inc: { 'variants.$.reserved': -hold.qty, version: 1 } },
          { session },
        ).exec()
        await StockReservation.updateOne(
          { _id: hold._id, workspaceId: hold.workspaceId },
          { $set: { status: 'released', releasedAt: new Date() } },
          { session },
        ).exec()
      }
      cancelled += 1
    })
  }
  return { cancelled }
}

/**
 * reservationExpirySweeper (every 5 min): held past expiresAt → released AND
 * reserved decremented IN ONE TRANSACTION (DB-07 — the reason there is no TTL).
 */
export async function sweepExpiredReservations(): Promise<{ released: number }> {
  const now = new Date()
  const expired = await StockReservation.find({ status: 'held', expiresAt: { $lt: now } }) // I46
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' })
    .limit(500)
    .exec()

  let released = 0
  for (const hold of expired) {
    await withTx(async (session) => {
      const claimed = await StockReservation.findOneAndUpdate(
        { _id: hold._id, status: 'held' },
        { $set: { status: 'released', releasedAt: now } },
        { new: true, session },
      )
        .setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' })
        .exec()
      if (!claimed) return // another sweeper instance won
      await Product.updateOne(
        { _id: claimed.productId, workspaceId: claimed.workspaceId, 'variants.sku': claimed.variantSku },
        { $inc: { 'variants.$.reserved': -claimed.qty, version: 1 } },
        { session },
      ).exec()
      released += 1
    })
  }
  return { released }
}
