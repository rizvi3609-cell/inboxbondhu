import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { Money } from '../../kernel/money.js'
import { moneyPlugin } from '../plugins/money.js'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D12 `orders`.
 * - items[] are SNAPSHOTS — a price change must never rewrite a past order.
 * - ADR-008 split statuses: a COD order is Delivered + Unpaid simultaneously.
 * - orderYear is immutable — year-scoped counters (DB-01).
 * - statusHistory is APPEND-ONLY. No code path rewrites it.
 * - The server calculates all totals (INV-04) — see Order.recalculate() below.
 */
const orderItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, required: true, ref: 'Product' }, // provenance only
    variantSku: { type: String, required: true }, // == products.variants[].sku (DB-15)
    nameSnapshot: { type: String, required: true },
    variantNameSnapshot: { type: String, required: true },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const statusHistorySchema = new Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    at: { type: Date, required: true },
    byType: { type: String, required: true, enum: ['ai', 'agent', 'system'] },
    byUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null },
  },
  { _id: false },
)

const orderSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    orderNumber: { type: Number, required: true, min: 1 },
    orderYear: { type: Number, required: true, immutable: true },
    orderCode: {
      type: String,
      required: true,
      immutable: true,
      match: /^ORD-\d{4}-\d{5}$/, // DB-unenforceable-rule companion: regex validator
    },
    conversationId: { type: Schema.Types.ObjectId, required: true, ref: 'Conversation' },
    customerId: { type: Schema.Types.ObjectId, required: true, ref: 'Customer' },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: { validator: (v: unknown[]) => v.length >= 1, message: 'at least one item' },
    },
    subtotalMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, required: true, min: 0, default: 0 },
    discountPercent: { type: Number, min: 0, max: 50, default: null },
    deliveryFeeMinor: { type: Number, required: true, min: 0, default: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
    deliveryZone: { type: String, required: true },
    deliveryAddress: { type: String, required: true, maxlength: 500 }, // PII
    recipientName: { type: String, required: true }, // PII
    recipientPhone: { type: String, required: true, match: /^01[3-9]\d{8}$/ }, // PII
    fulfillmentStatus: {
      type: String,
      required: true,
      enum: ['Collecting', 'AwaitingConfirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled'],
      default: 'Collecting',
    },
    paymentStatus: {
      type: String,
      required: true,
      enum: ['Unpaid', 'PaymentPending', 'PaymentFailed', 'Paid', 'Refunded'],
      default: 'Unpaid',
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: ['cod', 'bkash', 'nagad', 'rocket'],
      default: 'cod',
    },
    paymentRef: { type: String, default: null },
    statusHistory: { type: [statusHistorySchema], required: true, default: [] },
    createdByType: { type: String, required: true, enum: ['ai', 'agent'] },
    confirmedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: null },
    purgeAfter: { type: Date, required: true }, // createdAt + 90d
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

orderSchema.plugin(tenancyPlugin)
orderSchema.plugin(occPlugin)
orderSchema.plugin(moneyPlugin)

/**
 * INV-04: the server calculates all totals — via the Money kernel primitive
 * (agent.md §6.3), never raw arithmetic. Discount FLOORS. Idempotent.
 */
orderSchema.methods['recalculate'] = function (this: {
  items: { quantity: number; unitPriceMinor: number; lineTotalMinor: number }[]
  subtotalMinor: number
  discountPercent?: number | null
  discountMinor: number
  deliveryFeeMinor: number
  totalMinor: number
}): void {
  let subtotal = Money.of(0)
  for (const item of this.items) {
    item.lineTotalMinor = Money.mulQty(item.unitPriceMinor, item.quantity)
    subtotal = Money.add(subtotal, item.lineTotalMinor)
  }
  this.subtotalMinor = subtotal
  this.discountMinor = Money.floorPercent(subtotal, this.discountPercent ?? 0)
  this.totalMinor = Money.add(Money.sub(subtotal, this.discountMinor), this.deliveryFeeMinor)
}

orderSchema.index({ workspaceId: 1, orderYear: 1, orderNumber: 1 }, { unique: true, name: 'I38' })
orderSchema.index({ workspaceId: 1, orderCode: 1 }, { unique: true, name: 'I39' })
orderSchema.index({ workspaceId: 1, fulfillmentStatus: 1, createdAt: -1 }, { name: 'I40' })
orderSchema.index({ workspaceId: 1, customerId: 1, createdAt: -1 }, { name: 'I41' })
orderSchema.index(
  { fulfillmentStatus: 1, createdAt: 1 },
  { name: 'I42', partialFilterExpression: { fulfillmentStatus: 'Collecting' } },
)
orderSchema.index({ workspaceId: 1, conversationId: 1 }, { name: 'I43' })
orderSchema.index({ purgeAfter: 1 }, { name: 'I44' })

export type OrderModelDoc = InferSchemaType<typeof orderSchema>
export const Order =
  (mongoose.models['Order'] as mongoose.Model<InferSchemaType<typeof orderSchema>>) ??
  mongoose.model('Order', orderSchema, 'orders')
