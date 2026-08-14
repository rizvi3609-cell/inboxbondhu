import { z } from 'zod'
import { bdPhone, isoDate, moneyMinor, objectIdString } from './common.js'

// ─── orders (D12) ────────────────────────────────────────────────────────────

/** ADR-008: split statuses. A COD order is Delivered + Unpaid simultaneously. */
export const fulfillmentStatus = z.enum([
  'Collecting',
  'AwaitingConfirmation',
  'Confirmed',
  'Processing',
  'Shipped',
  'Delivered',
  'Cancelled',
])
export const paymentStatus = z.enum(['Unpaid', 'PaymentPending', 'PaymentFailed', 'Paid', 'Refunded'])
// database.md §2.12 is the field authority: cod | bkash | nagad | rocket.
export const paymentMethod = z.enum(['cod', 'bkash', 'nagad', 'rocket'])

/** items[] — a price SNAPSHOT, not a live join. `variantSku` here == variants[].sku (DB-15). */
export const orderItem = z
  .object({
    productId: objectIdString, // provenance only
    variantSku: z.string().min(1),
    nameSnapshot: z.string().min(1),
    variantNameSnapshot: z.string().min(1),
    unitPriceMinor: moneyMinor,
    quantity: z.number().int().min(1),
    lineTotalMinor: moneyMinor, // quantity × unitPriceMinor — server-calculated
  })
  .strict()

export const statusHistoryEntry = z
  .object({
    from: z.string(),
    to: z.string(),
    at: isoDate,
    byType: z.enum(['ai', 'agent', 'system']),
    byUserId: objectIdString.nullish(),
    note: z.string().nullish(),
  })
  .strict()

export const OrderDoc = z
  .object({
    workspaceId: objectIdString,
    orderNumber: z.number().int().min(1).nullish(), // set at T1 confirm (drafts: null)
    orderYear: z.number().int().min(2020).nullish(), // immutable once set — counter scope (DB-01)
    orderCode: z.string().regex(/^ORD-\d{4}-\d{5}$/).nullish(), // set at T1 confirm
    conversationId: objectIdString,
    customerId: objectIdString,
    items: z.array(orderItem).min(1),
    subtotalMinor: moneyMinor, // Σ lineTotalMinor — server-calculated (INV-04)
    discountMinor: moneyMinor,
    discountPercent: z.number().int().min(0).max(50).nullish(),
    deliveryFeeMinor: moneyMinor,
    totalMinor: moneyMinor, // subtotal − discount + delivery
    deliveryZone: z.string().min(1),
    deliveryAddress: z.string().min(1).max(500), // PII
    recipientName: z.string().min(1), // PII
    recipientPhone: bdPhone, // PII
    fulfillmentStatus: fulfillmentStatus.default('Collecting'),
    paymentStatus: paymentStatus.default('Unpaid'),
    paymentMethod: paymentMethod.default('cod'),
    paymentRef: z.string().nullish(),
    statusHistory: z.array(statusHistoryEntry).default([]), // append-only
    createdByType: z.enum(['ai', 'agent']),
    draftLastTouchedAt: isoDate.nullish(), // abandonedOrderSweeper key (§11.2)
    confirmedAt: isoDate.nullish(),
    cancelledAt: isoDate.nullish(),
    cancellationReason: z.string().nullish(),
    version: z.number().int().min(0).default(0),
    purgeAfter: isoDate, // createdAt + 90d
  })
  .strict()
export type OrderDoc = z.infer<typeof OrderDoc>

// ─── orderCounters (D13) — _id is the string "{workspaceId}:{year}" ─────────

export const OrderCounterDoc = z
  .object({
    _id: z.string().regex(/^[0-9a-fA-F]{24}:\d{4}$/),
    workspaceId: objectIdString, // redundant, queryable duplicate
    year: z.number().int(),
    seq: z.number().int().min(0),
    updatedAt: isoDate,
  })
  .strict()
export type OrderCounterDoc = z.infer<typeof OrderCounterDoc>

// ─── stockReservations (D14) — deliberately NO TTL index (DB-07) ────────────

export const reservationStatus = z.enum(['held', 'committed', 'released'])

export const StockReservationDoc = z
  .object({
    workspaceId: objectIdString,
    orderId: objectIdString,
    productId: objectIdString,
    variantSku: z.string().min(1),
    qty: z.number().int().min(1),
    status: reservationStatus.default('held'),
    /** createdAt + 24h. NO TTL index — the sweeper releases AND decrements in one transaction. */
    expiresAt: isoDate,
    releasedAt: isoDate.nullish(),
    committedAt: isoDate.nullish(),
  })
  .strict()
export type StockReservationDoc = z.infer<typeof StockReservationDoc>
