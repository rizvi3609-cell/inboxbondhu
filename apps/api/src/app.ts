/**
 * apps/api — THIN. No business logic (agent.md §5). Phase 0 exposes only
 * /healthz and /readyz; the middleware chain and v1 routes arrive in Phase 2+.
 */
import express, { type Express } from 'express'
import type { DbClients } from '@inboxbondhu/core'
import { healthCheck } from '@inboxbondhu/core'

export interface AppDeps {
  clients: DbClients | null // null in unit tests that only hit /healthz
  version: string
  startedAt: number
}

export function createApp(deps: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')

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

  return app
}
