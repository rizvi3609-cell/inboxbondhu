/**
 * apps/api — THIN. Phase 0: /healthz + /readyz. Phase 2: auth, me,
 * workspaces, members, invitations. Middleware order per §8.1.
 */
import express, { type Express } from 'express'
import cookieParser from 'cookie-parser'
import type { Redis } from 'ioredis'
import type { CatalogueService, ChannelsService, DbClients, InboxService, KnowledgeService, ObservabilityService, OrdersService, PaymentsService, PlansService } from '@inboxbondhu/core'
import { healthCheck, IdentityService, WorkspaceService } from '@inboxbondhu/core'
import {
  auth as authMiddleware, csrf as csrfMiddleware, tenant as tenantMiddleware,
  errorHandler, membershipCacheInvalidator, requestId,
} from './middleware/core.js'
import { authRouter, meRouter } from './routes/v1/auth.js'
import { workspacesRouter } from './routes/v1/workspaces.js'
import { channelsRouter } from './routes/v1/channels.js'
import { conversationsRouter, messagesRouter } from './routes/v1/conversations.js'
import { importsRouter, knowledgeRouter, productsRouter } from './routes/v1/catalogue.js'
import { ordersRouter, paymentsRouter } from './routes/v1/orders.js'
import { opsRouter, realtimeTicketRouter } from './routes/v1/ops.js'
import type { Queue } from 'bullmq'
import { metaWebhookRouter, type MetaWebhookDeps } from './routes/webhooks/meta.js'

export interface AppDeps {
  clients: DbClients | null // null in unit tests that only hit /healthz
  version: string
  startedAt: number
  auth?: {
    jwtSecret: string
    jwtSecretPrevious?: string
    pepper: string
    accessTtlSeconds: number
    refreshTtlDays: number
    maxSessions: number
    secureCookies: boolean
  }
  /** Phase 3: the ≤500 ms Meta webhook path. */
  webhook?: MetaWebhookDeps
  /** Phase 3: channel management routes (#35–39). */
  channels?: { service: ChannelsService; metaAppId: string; apiUrl: string }
  /** Phase 4: inbox routes (#40–45). */
  inbox?: { service: InboxService }
  /** Phase 7: orders + payments routes (#58–65). */
  orders?: { orders: OrdersService; payments: PaymentsService }
  /** Phase 8: analytics/usage/settings/plan/audit/jobs + realtime ticket. */
  ops?: {
    observability: ObservabilityService
    plans: PlansService
    queues: Map<string, Queue>
    ticketSecret: string
  }
  /** Phase 5: catalogue + knowledge routes (#46–57). */
  catalogue?: {
    catalogue: CatalogueService
    knowledge: KnowledgeService
    enqueueImport: (job: { workspaceId: string; requestId: string; payload: { importId: string } }) => Promise<void>
  }
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(requestId())

  // Webhook FIRST — before json body-parsing, rate limits, auth, csrf, tenant
  // (§8.1: nothing that can touch Mongo/Redis synchronously in front of it;
  // it needs the raw body for the HMAC).
  if (deps.webhook) {
    app.use('/webhooks', metaWebhookRouter(deps.webhook))
  }

  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())

  // Liveness: process is up. Never touches a dependency.
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      data: {
        status: 'ok',
        version: deps.version,
        uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      },
    })
  })

  // Readiness: Mongo + Redis ping. 503 DEGRADED_MODE when a dependency is down.
  app.get('/readyz', (req, res) => {
    void (async () => {
      if (!deps.clients) {
        res.status(503).json({ error: { code: 'DEGRADED_MODE', message: 'data layer not initialised' } })
        return
      }
      const health = await healthCheck(deps.clients)
      if (health.mongo && health.redis) {
        res.status(200).json({ data: { status: 'ready', mongo: true, redis: true } })
      } else {
        res.status(503).json({
          error: { code: 'DEGRADED_MODE', message: 'dependency unavailable', details: health },
        })
      }
    })()
  })

  // Phase 2 routes — only when auth config is provided.
  if (deps.auth) {
    const redis: Redis | null = deps.clients?.redis ?? null
    const identity = new IdentityService({
      jwtSecret: deps.auth.jwtSecret,
      accessTtlSeconds: deps.auth.accessTtlSeconds,
      refreshTtlDays: deps.auth.refreshTtlDays,
      maxSessions: deps.auth.maxSessions,
    })
    const workspace = new WorkspaceService(membershipCacheInvalidator(redis))

    const routerDeps = {
      identity,
      redis,
      jwtSecret: deps.auth.jwtSecret,
      jwtSecretPrevious: deps.auth.jwtSecretPrevious,
      pepper: deps.auth.pepper,
      secureCookies: deps.auth.secureCookies,
    }
    app.use('/api/v1/auth', authRouter(routerDeps))
    app.use('/api/v1/me', meRouter(routerDeps))
    app.use(
      '/api/v1',
      workspacesRouter({
        workspace,
        redis,
        jwtSecret: deps.auth.jwtSecret,
        jwtSecretPrevious: deps.auth.jwtSecretPrevious,
      }),
    )

    // #40–45: /w/:workspaceId/conversations + /messages.
    if (deps.inbox) {
      const inboxService = deps.inbox.service
      app.use(
        '/api/v1/w/:workspaceId/conversations',
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
        conversationsRouter({ inbox: inboxService }),
      )
      app.use(
        '/api/v1/w/:workspaceId/messages',
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
        messagesRouter({ inbox: inboxService }),
      )
    }

    // #46–57: /w/:workspaceId/{products,imports,knowledge}.
    if (deps.catalogue) {
      const chain = [
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
      ] as const
      app.use('/api/v1/w/:workspaceId/products', ...chain, productsRouter({
        catalogue: deps.catalogue.catalogue, redis, enqueueImport: deps.catalogue.enqueueImport,
      }))
      app.use('/api/v1/w/:workspaceId/imports', ...chain, importsRouter({ catalogue: deps.catalogue.catalogue }))
      app.use('/api/v1/w/:workspaceId/knowledge', ...chain, knowledgeRouter({ knowledge: deps.catalogue.knowledge }))
    }

    // #24 + #66–76: realtime ticket (session-scoped) and workspace ops.
    if (deps.ops) {
      app.use('/api/v1/realtime', realtimeTicketRouter({
        jwtSecret: deps.auth.jwtSecret,
        jwtSecretPrevious: deps.auth.jwtSecretPrevious,
        ticketSecret: deps.ops.ticketSecret,
      }))
      app.use(
        '/api/v1/w/:workspaceId',
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
        opsRouter({ observability: deps.ops.observability, plans: deps.ops.plans, queues: deps.ops.queues }),
      )
    }

    // #58–65: /w/:workspaceId/{orders,payments}.
    if (deps.orders) {
      const chain = [
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
      ] as const
      app.use('/api/v1/w/:workspaceId/orders', ...chain, ordersRouter(deps.orders))
      app.use('/api/v1/w/:workspaceId/payments', ...chain, paymentsRouter({ payments: deps.orders.payments }))
    }

    // #35–39: /w/:workspaceId/channels — behind auth+csrf+tenant like the rest.
    if (deps.channels) {
      app.use(
        '/api/v1/w/:workspaceId/channels',
        authMiddleware(deps.auth.jwtSecret, deps.auth.jwtSecretPrevious),
        csrfMiddleware(),
        tenantMiddleware(redis),
        channelsRouter({
          channels: deps.channels.service,
          metaAppId: deps.channels.metaAppId,
          apiUrl: deps.channels.apiUrl,
        }),
      )
    }
  }

  app.use(errorHandler())
  return app
}
