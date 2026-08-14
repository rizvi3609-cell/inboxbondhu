/**
 * Phase 8 routes: #24 realtime ticket, #66–68 analytics/usage, #69–71
 * settings PATCHes, #72–73 plan (owner), #74 audit-logs, #75–76 failed jobs.
 */
import { Router } from 'express'
import { z } from 'zod'
import type { Queue } from 'bullmq'
import {
  AppError, Workspace, occFilter, throwVersionConflict,
  type ObservabilityService, type PlansService,
} from '@inboxbondhu/core'
import { objectIdString } from '@inboxbondhu/contracts'
import { auth, csrf, requireRole, validate } from '../../middleware/core.js'
import { issueTicket } from '../../realtime/gateway.js'

const dateRange = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).passthrough()

function requireIfMatch(header: string | undefined): number {
  if (header === undefined) throw new AppError('PRECONDITION_REQUIRED', 'If-Match header required.')
  const v = Number(header)
  if (!Number.isInteger(v) || v < 0) throw new AppError('VALIDATION_FAILED', 'If-Match must be a non-negative integer version.')
  return v
}

/** #24 GET /realtime/ticket — session-scoped (no workspace context). */
export function realtimeTicketRouter(deps: { jwtSecret: string; jwtSecretPrevious?: string; ticketSecret: string }): Router {
  const router = Router()
  router.get('/ticket', auth(deps.jwtSecret, deps.jwtSecretPrevious), (req, res) => {
    // 60 s signed ticket — the access token never travels over the WS (§12.1).
    res.json({ data: { ticket: issueTicket(req.auth!.userId, deps.ticketSecret), expiresInSeconds: 60 } })
  })
  return router
}

export function opsRouter(deps: {
  observability: ObservabilityService
  plans: PlansService
  queues: Map<string, Queue>
}): Router {
  const router = Router({ mergeParams: true })

  // #66 analytics summary — viewer
  router.get('/analytics/summary', requireRole('viewer'), validate({ query: dateRange }), (req, res, next) => {
    void (async () => {
      const q = req.query as unknown as { from?: Date; to?: Date }
      const to = q.to ?? new Date()
      const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000)
      const result = await deps.observability.summary(req.tenant!, from, to)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #67 timeseries — viewer
  router.get(
    '/analytics/timeseries',
    requireRole('viewer'),
    validate({ query: dateRange.extend({ metric: z.enum(['conversations', 'orders', 'ai_replies']) }) }),
    (req, res, next) => {
      void (async () => {
        const q = req.query as unknown as { metric: 'conversations' | 'orders' | 'ai_replies'; from?: Date; to?: Date }
        const to = q.to ?? new Date()
        const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000)
        const result = await deps.observability.timeseries(req.tenant!, q.metric, from, to)
        if (!result.ok) throw result.error
        res.json({ data: result.value })
      })().catch(next)
    },
  )

  // #68 usage — admin
  router.get('/usage', requireRole('admin'), (req, res, next) => {
    void (async () => {
      const status = await deps.plans.quotaStatus(req.tenant!.workspaceId)
      res.json({ data: status })
    })().catch(next)
  })

  // #69–71 settings PATCHes — admin + If-Match, routed onto the workspace doc.
  const settingsPatch = (pick: (body: Record<string, unknown>) => Record<string, unknown>) =>
    (req: Parameters<Parameters<Router['patch']>[1]>[0], res: Parameters<Parameters<Router['patch']>[1]>[1], next: (e?: unknown) => void) => {
      void (async () => {
        const expected = requireIfMatch(req.header('If-Match'))
        const $set = pick(req.body as Record<string, unknown>)
        if (Object.keys($set).length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing to update.')
        const result = await Workspace.updateOne(
          { _id: req.tenant!.workspaceId, ...occFilter(expected) },
          { $set },
        ).exec()
        if (result.matchedCount === 0) {
          const fresh = await Workspace.findOne({ _id: req.tenant!.workspaceId }).exec()
          if (!fresh) throw new AppError('NOT_FOUND', 'Workspace not found.')
          throwVersionConflict(fresh.version, Object.keys($set))
        }
        res.json({ data: { updated: true, version: expected + 1 } })
      })().catch(next)
    }

  const aiSettings = z.object({
    enabled: z.boolean().optional(),
    tone: z.enum(['friendly', 'formal', 'concise']).optional(),
    autoReplyEnabled: z.boolean().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    handoverKeywords: z.array(z.string().min(1).max(60)).max(50).optional(),
    maxDiscountPercent: z.number().int().min(0).max(50).optional(),
  }).strict()
  router.patch('/settings/ai', requireRole('admin'), validate({ body: aiSettings }), settingsPatch((b) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(b)) out[`aiConfig.${k}`] = v
    return out
  }))

  const hoursSettings = z.object({
    enabled: z.boolean(),
    days: z.array(z.object({
      day: z.number().int().min(0).max(6),
      open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      closed: z.boolean(),
    }).strict()).length(7),
    awayMessage: z.string().max(500).nullish(),
  }).strict()
  router.patch('/settings/business-hours', requireRole('admin'), validate({ body: hoursSettings }), settingsPatch((b) => ({ businessHours: b })))

  const zonesSettings = z.object({
    deliveryZones: z.array(z.object({
      name: z.string().min(1).max(80),
      feeMinor: z.number().int().min(0),
      etaDays: z.number().int().min(0).max(30),
    }).strict()).max(50),
  }).strict()
  router.patch('/settings/delivery-zones', requireRole('admin'), validate({ body: zonesSettings }), settingsPatch((b) => ({ deliveryZones: b['deliveryZones'] })))

  // #72–73 plan — OWNER only (enforced again in the service).
  router.get('/plan', requireRole('owner'), (req, res, next) => {
    void (async () => {
      const result = await deps.plans.getPlan(req.tenant!)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })
  router.post(
    '/plan/change',
    requireRole('owner'),
    validate({ body: z.object({ plan: z.enum(['trial', 'starter', 'growth']) }).strict() }),
    (req, res, next) => {
      void (async () => {
        const result = await deps.plans.changePlan(req.tenant!, (req.body as { plan: 'trial' | 'starter' | 'growth' }).plan)
        if (!result.ok) throw result.error
        res.json({ data: result.value })
      })().catch(next)
    },
  )

  // #74 audit logs — admin
  router.get(
    '/audit-logs',
    requireRole('admin'),
    validate({ query: dateRange.extend({
      actorId: z.string().max(40).optional(),
      action: z.string().max(60).optional(),
      resourceType: z.string().max(40).optional(),
      cursor: objectIdString.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }) }),
    (req, res, next) => {
      void (async () => {
        const q = req.query as Record<string, unknown>
        const result = await deps.observability.auditLogs(req.tenant!, {
          ...(q['actorId'] ? { actorId: q['actorId'] as string } : {}),
          ...(q['action'] ? { action: q['action'] as string } : {}),
          ...(q['resourceType'] ? { resourceType: q['resourceType'] as string } : {}),
          ...(q['from'] ? { from: q['from'] as Date } : {}),
          ...(q['to'] ? { to: q['to'] as Date } : {}),
          ...(q['cursor'] ? { cursor: q['cursor'] as string } : {}),
          ...(q['limit'] ? { limit: q['limit'] as number } : {}),
        })
        if (!result.ok) throw result.error
        res.json({ data: result.value })
      })().catch(next)
    },
  )

  // #75 failed jobs — agent (BullMQ failed + DLQ)
  router.get('/jobs/failed', requireRole('agent'), (req, res, next) => {
    void (async () => {
      const out: Array<Record<string, unknown>> = []
      for (const [name, queue] of deps.queues) {
        const failed = await queue.getFailed(0, 50)
        for (const job of failed) {
          const data = job.data as { workspaceId?: string; requestId?: string }
          if (data.workspaceId !== req.tenant!.workspaceId) continue // tenant filter
          out.push({
            id: `${name}:${job.id}`, queue: name,
            requestId: data.requestId ?? null,
            failedReason: (job.failedReason ?? '').slice(0, 300),
            attemptsMade: job.attemptsMade,
            timestamp: job.timestamp,
          })
        }
      }
      res.json({ data: { jobs: out } })
    })().catch(next)
  })

  // #76 retry — agent; payment/webhook retries need admin (§13.3).
  router.post(
    '/jobs/:id/retry',
    requireRole('agent'),
    validate({ params: z.object({ id: z.string().regex(/^[a-z-]+:[\w-]+$/) }).passthrough() }),
    (req, res, next) => {
      void (async () => {
        const [queueName, jobId] = (req.params['id'] as string).split(':') as [string, string]
        if (['payment-events', 'webhook-ingest'].includes(queueName) && !['owner', 'admin'].includes(req.tenant!.role)) {
          throw new AppError('INSUFFICIENT_PERMISSIONS', 'Payment and webhook retries require admin.')
        }
        const queue = deps.queues.get(queueName)
        if (!queue) throw new AppError('NOT_FOUND', 'Queue not found.')
        const job = await queue.getJob(jobId)
        if (!job) throw new AppError('NOT_FOUND', 'Job not found.')
        const data = job.data as { workspaceId?: string }
        if (data.workspaceId !== req.tenant!.workspaceId) throw new AppError('NOT_FOUND', 'Job not found.') // never leak
        await job.retry()
        res.json({ data: { retried: true } })
      })().catch(next)
    },
  )

  return router
}

export { csrf }
