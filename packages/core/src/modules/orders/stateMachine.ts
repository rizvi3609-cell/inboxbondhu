/**
 * §11.1 — the two state machines (ADR-008). Explicit transition map; an
 * illegal transition is 409 INVALID_STATE_TRANSITION, never a silent no-op.
 * Processing → Cancelled requires order:cancel_processing (owner/admin).
 * Shipped/Delivered are terminal for cancellation (returns are P1).
 */
export type FulfillmentStatus =
  | 'Collecting' | 'AwaitingConfirmation' | 'Confirmed'
  | 'Processing' | 'Shipped' | 'Delivered' | 'Cancelled'

export type PaymentStatus = 'Unpaid' | 'PaymentPending' | 'PaymentFailed' | 'Paid' | 'Refunded'

export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  Collecting: ['AwaitingConfirmation', 'Cancelled'],
  AwaitingConfirmation: ['Confirmed', 'Cancelled', 'Collecting'], // back to Collecting when details change
  Confirmed: ['Processing', 'Cancelled'],
  Processing: ['Shipped', 'Cancelled'], // Cancelled = carve-out permission
  Shipped: ['Delivered'],
  Delivered: [], // terminal (COD may still be Unpaid here — ADR-008)
  Cancelled: [],
}

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  Unpaid: ['PaymentPending', 'Paid'], // COD: cash recorded on delivery → Paid directly
  PaymentPending: ['Paid', 'PaymentFailed'],
  PaymentFailed: ['PaymentPending'], // retry loop (ADR-008)
  Paid: ['Refunded'],
  Refunded: [],
}

export function canTransitionFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return FULFILLMENT_TRANSITIONS[from]?.includes(to) ?? false
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from]?.includes(to) ?? false
}

/** §8.7 carve-outs — enforced in the SERVICE, not by route role alone. */
export const DISCOUNT_ROLES: ReadonlySet<string> = new Set(['owner', 'admin'])
export const CANCEL_PROCESSING_ROLES: ReadonlySet<string> = new Set(['owner', 'admin'])
