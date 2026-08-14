/**
 * Orders + payments routes (§7.3 #58–65) — THIN. Viewer reads; agent+
 * creates/updates (carve-outs enforced in the service); the payment-link
 * route is THE one 501 at MVP.
 */
import { Router } from 'express'
import { z } from 'zod'
import { AppError, type OrdersService, type PaymentsService } from '@inboxbondhu/core'
import {
  CancelOrderBody, CreateOrderBody, ListOrdersQuery, UpdateOrderBody, objectIdString,
} from '@inboxbondhu/contracts'
import { requireRole, validate } from '../../middleware/core.js'

const idParam = z.object({ id: objectIdString }).passthrough()

function requireIfMatch(header: string | undefined): number {
  if (header === undefined) throw new AppError('PRECONDITION_REQUIRED', 'If-Match header required.')
  const v = Number(header)
  if (!Number.isInteger(v) || v < 0) throw new AppError('VALIDATION_FAILED', 'If-Match must be a non-negative integer version.')
  return v
}

function requireIdempotencyKey(header: string | undefined): string {
  if (!header) throw new AppError('PRECONDITION_REQUIRED', 'Idempotency-Key header required.')
  if (header.length < 8 || header.length > 128) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 8–128 characters.')
  }
  return header
}

export function ordersRouter(deps: { orders: OrdersService; payments: PaymentsService }): Router {
  const router = Router({ mergeParams: true })

  // #58 list — viewer
  router.get('/', requireRole('viewer'), validate({ query: ListOrdersQuery }), (req, res, next) => {
    void (async () => {
      const q = req.query as z.infer<typeof ListOrdersQuery>
      const result = await deps.orders.list(req.tenant!, {
        ...(q.fulfillmentStatus && { fulfillmentStatus: q.fulfillmentStatus }),
        ...(q.paymentStatus && { paymentStatus: q.paymentStatus }),
        ...(q.customerId && { customerId: q.customerId }),
        ...(q.q && { q: q.q }),
        ...(q.from && { from: q.from }),
        ...(q.to && { to: q.to }),
        ...(q.cursor && { cursor: q.cursor }),
        ...(q.limit && { limit: q.limit }),
      })
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #59 get — viewer
  router.get('/:id', requireRole('viewer'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.orders.get(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #60 create — agent+, Idempotency-Key required (replay → 200, never 201)
  router.post('/', requireRole('agent'), validate({ body: CreateOrderBody }), (req, res, next) => {
    void (async () => {
      const key = requireIdempotencyKey(req.header('Idempotency-Key'))
      const result = await deps.orders.create(req.tenant!, key, req.body as z.infer<typeof CreateOrderBody>)
      if (!result.ok) throw result.error
      res.status(result.value.replayed ? 200 : 201).json({ data: result.value.order })
    })().catch(next)
  })

  // #61 update — agent+ (carve-outs in service), If-Match required
  router.patch('/:id', requireRole('agent'), validate({ params: idParam, body: UpdateOrderBody }), (req, res, next) => {
    void (async () => {
      const expected = requireIfMatch(req.header('If-Match'))
      const result = await deps.orders.update(
        req.tenant!, req.params['id'] as string, expected, req.body as z.infer<typeof UpdateOrderBody>,
      )
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #62 confirm — T1
  router.post('/:id/confirm', requireRole('agent'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.orders.confirm(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #63 cancel — releases reservations; Processing carve-out in service
  router.post('/:id/cancel', requireRole('agent'), validate({ params: idParam, body: CancelOrderBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.orders.cancel(req.tenant!, req.params['id'] as string, (req.body as { reason: string }).reason)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #65 payment-link — THE one 501 route at MVP
  router.post('/:id/payment-link', requireRole('agent'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = deps.payments.paymentLink()
      if (!result.ok) throw result.error
    })().catch(next)
  })

  return router
}

/** #64 GET /payments/providers — mounted at /w/:workspaceId/payments. */
export function paymentsRouter(deps: { payments: PaymentsService }): Router {
  const router = Router({ mergeParams: true })
  router.get('/providers', requireRole('viewer'), (req, res, next) => {
    void (async () => {
      const result = deps.payments.providers()
      res.json({ data: result.ok ? result.value : [] })
    })().catch(next)
  })
  return router
}
