/**
 * apps/api — THIN. Phase 0: /healthz + /readyz. Phase 2: auth, me,
 * workspaces, members, invitations. Middleware order per §8.1.
 */
import express, { type Express } from 'express'
import cookieParser from 'cookie-parser'
import type { Redis } from 'ioredis'
import type { DbClients } from '@inboxbondhu/core'
import { healthCheck, IdentityService, WorkspaceService } from '@inboxbondhu/core'
import { errorHandler, membershipCacheInvalidator, requestId } from './middleware/core.js'
import { authRouter, meRouter } from './routes/v1/auth.js'
import { workspacesRouter } from './routes/v1/workspaces.js'

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
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(requestId())
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
  }

  app.use(errorHandler())
  return app
}
