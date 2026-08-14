import { z } from 'zod'
import { bdPhone, objectIdString } from './common.js'

/**
 * Orders API bodies (§7.3 #58–65). NOTE: no money fields are accepted — the
 * server calculates all totals (INV-04). A client-sent total is not even
 * parseable here (strict schemas reject unknown keys).
 */

const orderItemInput = z
  .object({
    productId: objectIdString,
    variantSku: z.string().min(1).max(64).transform((v) => v.toUpperCase()),
    quantity: z.number().int().min(1).max(1000),
  })
  .strict()

export const CreateOrderBody = z
  .object({
    conversationId: objectIdString,
    customerId: objectIdString,
    items: z.array(orderItemInput).min(1).max(50),
    recipientName: z.string().trim().min(1).max(120),
    recipientPhone: bdPhone,
    deliveryAddress: z.string().trim().min(1).max(500),
    deliveryZone: z.string().trim().min(1).max(80),
    discountPercent: z.number().int().min(0).max(50).optional(),
    paymentMethod: z.enum(['cod', 'bkash', 'nagad', 'rocket']).optional(),
  })
  .strict()
export type CreateOrderBody = z.infer<typeof CreateOrderBody>

export const UpdateOrderBody = z
  .object({
    items: z.array(orderItemInput).min(1).max(50).optional(),
    discountPercent: z.number().int().min(0).max(50).optional(),
    deliveryAddress: z.string().trim().min(1).max(500).optional(),
    deliveryZone: z.string().trim().min(1).max(80).optional(),
    recipientName: z.string().trim().min(1).max(120).optional(),
    recipientPhone: bdPhone.optional(),
    paymentMethod: z.enum(['cod', 'bkash', 'nagad', 'rocket']).optional(),
    fulfillmentStatus: z.enum(['Collecting', 'AwaitingConfirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']).optional(),
    paymentStatus: z.enum(['Unpaid', 'PaymentPending', 'PaymentFailed', 'Paid', 'Refunded']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field required')
export type UpdateOrderBody = z.infer<typeof UpdateOrderBody>

export const CancelOrderBody = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict()

export const ListOrdersQuery = z
  .object({
    fulfillmentStatus: z.enum(['Collecting', 'AwaitingConfirmation', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled']).optional(),
    paymentStatus: z.enum(['Unpaid', 'PaymentPending', 'PaymentFailed', 'Paid', 'Refunded']).optional(),
    customerId: objectIdString.optional(),
    q: z.string().max(40).optional(), // orderCode search (I39)
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    cursor: objectIdString.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()
