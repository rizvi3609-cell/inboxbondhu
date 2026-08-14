/**
 * Channel routes (§7.3 #35–39) — admin-gated, THIN.
 * OAuth callback state mismatch → 403 CSRF_TOKEN_INVALID.
 */
import { Router } from 'express'
import { z } from 'zod'
import type { ChannelsService } from '@inboxbondhu/core'
import { objectIdString } from '@inboxbondhu/contracts'
import { requireRole, validate } from '../../middleware/core.js'

export function channelsRouter(deps: {
  channels: ChannelsService
  metaAppId: string
  apiUrl: string
}): Router {
  const router = Router({ mergeParams: true })
  const redirectUri = `${deps.apiUrl}/api/v1/channels/oauth/callback`

  // #35 list
  router.get('/', requireRole('admin'), (req, res, next) => {
    void (async () => {
      const result = await deps.channels.list(req.tenant!)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #36 oauth start
  router.get('/oauth/start', requireRole('admin'), (req, res, next) => {
    void (async () => {
      const result = await deps.channels.startOAuth(req.tenant!, deps.metaAppId, redirectUri)
      if (!result.ok) throw result.error
      res.json({ data: { url: result.value.url } })
    })().catch(next)
  })

  // #37 oauth callback — state validated in the service (403 on mismatch)
  router.get(
    '/oauth/callback',
    requireRole('admin'),
    validate({ query: z.object({ state: z.string().min(1), code: z.string().min(1) }).passthrough() }),
    (req, res, next) => {
      void (async () => {
        const { state, code } = req.query as { state: string; code: string }
        const result = await deps.channels.completeOAuth(req.tenant!, state, code, redirectUri)
        if (!result.ok) throw result.error
        res.status(201).json({ data: result.value })
      })().catch(next)
    },
  )

  // #38 disconnect (soft)
  router.delete(
    '/:id',
    requireRole('admin'),
    validate({ params: z.object({ id: objectIdString }).passthrough() }),
    (req, res, next) => {
      void (async () => {
        const result = await deps.channels.disconnect(req.tenant!, req.params['id'] as string)
        if (!result.ok) throw result.error
        res.json({ data: { disconnected: true } })
      })().catch(next)
    },
  )

  // #39 reconnect — same OAuth flow; returns the start URL.
  router.post(
    '/:id/reconnect',
    requireRole('admin'),
    validate({ params: z.object({ id: objectIdString }).passthrough() }),
    (req, res, next) => {
      void (async () => {
        const result = await deps.channels.startOAuth(req.tenant!, deps.metaAppId, redirectUri)
        if (!result.ok) throw result.error
        res.json({ data: { url: result.value.url } })
      })().catch(next)
    },
  )

  return router
}
