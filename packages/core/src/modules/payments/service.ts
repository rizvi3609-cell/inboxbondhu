/**
 * MOD-09 payments — §11.7 abstraction, COD-only at MVP. The interface is
 * honest now so P1 (bKash/Nagad/Rocket) is an adapter, not a refactor.
 * POST /orders/:id/payment-link is THE one 501 route at MVP.
 */
import { AppError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { Order } from '../../db/models/index.js'
import { canTransitionPayment, type PaymentStatus } from '../orders/stateMachine.js'

export interface PaymentIntent {
  provider: string
  status: PaymentStatus
}

export interface PaymentProvider {
  readonly id: 'cod' | 'bkash' | 'nagad' | 'rocket'
  createIntent(ctx: TenantContext, orderId: string): Promise<PaymentIntent>
}

export class CodProvider implements PaymentProvider {
  readonly id = 'cod' as const

  async createIntent(): Promise<PaymentIntent> {
    // COD: nothing to do — the order stays Unpaid until cash is recorded.
    return { provider: 'cod', status: 'Unpaid' }
  }
}

export class PaymentsService {
  /** #64 GET /payments/providers — COD available; online comingSoon (PRD §2.10). */
  providers(): Result<Array<{ id: string; enabled: boolean; comingSoon: boolean }>, never> {
    return Result.ok([
      { id: 'cod', enabled: true, comingSoon: false },
      { id: 'bkash', enabled: false, comingSoon: true },
      { id: 'nagad', enabled: false, comingSoon: true },
      { id: 'rocket', enabled: false, comingSoon: true },
    ])
  }

  /** #65 POST /orders/:id/payment-link — defined, NOT callable at MVP. */
  paymentLink(): Result<never, AppError> {
    return Result.err(new AppError('NOT_IMPLEMENTED', 'Online payment links arrive with the P1 provider integration.'))
  }

  /**
   * Record COD cash (Unpaid → Paid). PRD §2.10 conflict handling: a payment
   * against a cancelled order is REJECTED, never blindly marked paid.
   */
  async recordCodPayment(ctx: TenantContext, orderId: string, paymentRef?: string): Promise<Result<{ paid: true }, AppError>> {
    const order = await Order.findOne({ _id: orderId, workspaceId: ctx.workspaceId }).exec()
    if (!order) return Result.err(new AppError('NOT_FOUND', 'Order not found.'))
    if (order.fulfillmentStatus === 'Cancelled') {
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Order was cancelled — do not record payment. Flag for review.'))
    }
    if (!canTransitionPayment(order.paymentStatus as PaymentStatus, 'Paid')) {
      return Result.err(new AppError('INVALID_STATE_TRANSITION', `Payment is ${order.paymentStatus} — cannot mark Paid.`))
    }
    await Order.updateOne(
      { _id: orderId, workspaceId: ctx.workspaceId, paymentStatus: order.paymentStatus },
      { $set: { paymentStatus: 'Paid', ...(paymentRef ? { paymentRef } : {}) } },
    ).exec()
    return Result.ok({ paid: true })
  }
}
