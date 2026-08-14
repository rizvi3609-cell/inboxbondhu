/**
 * Catalogue + knowledge routes (§7.3 #46–57) — THIN. Viewer reads; admin
 * mutates (Product & FAQ CRUD is admin-only per §8.7 — agents cannot).
 */
import { Router } from 'express'
import { z } from 'zod'
import { AppError, type CatalogueService, type KnowledgeService } from '@inboxbondhu/core'
import {
  CreateKnowledgeBody, CreateProductBody, ListKnowledgeQuery, ListProductsQuery,
  UpdateKnowledgeBody, UpdateProductBody, objectIdString,
} from '@inboxbondhu/contracts'
import { rateLimit, requireRole, validate } from '../../middleware/core.js'
import type { Redis } from 'ioredis'

const idParam = z.object({ id: objectIdString }).passthrough()

function requireIfMatch(header: string | undefined): number {
  if (header === undefined) throw new AppError('PRECONDITION_REQUIRED', 'If-Match header required.')
  const v = Number(header)
  if (!Number.isInteger(v) || v < 0) throw new AppError('VALIDATION_FAILED', 'If-Match must be a non-negative integer version.')
  return v
}

export function productsRouter(deps: {
  catalogue: CatalogueService
  redis: Redis | null
  enqueueImport: (job: { workspaceId: string; requestId: string; payload: { importId: string } }) => Promise<void>
}): Router {
  const router = Router({ mergeParams: true })

  // #46 list — viewer
  router.get('/', requireRole('viewer'), validate({ query: ListProductsQuery }), (req, res, next) => {
    void (async () => {
      const q = req.query as z.infer<typeof ListProductsQuery>
      const result = await deps.catalogue.list(req.tenant!, {
        ...(q.status && { status: q.status }),
        ...(q.q && { q: q.q }),
        ...(q.cursor && { cursor: q.cursor }),
        ...(q.limit && { limit: q.limit }),
      })
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  router.get('/:id', requireRole('viewer'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.catalogue.get(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #47 create — admin
  router.post('/', requireRole('admin'), validate({ body: CreateProductBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.catalogue.create(req.tenant!, req.body as z.infer<typeof CreateProductBody>)
      if (!result.ok) throw result.error
      res.status(201).json({ data: result.value })
    })().catch(next)
  })

  // #48 update — admin + If-Match
  router.patch('/:id', requireRole('admin'), validate({ params: idParam, body: UpdateProductBody }), (req, res, next) => {
    void (async () => {
      const expected = requireIfMatch(req.header('If-Match'))
      const result = await deps.catalogue.update(
        req.tenant!, req.params['id'] as string, expected, req.body as z.infer<typeof UpdateProductBody>,
      )
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #49 DELETE = archive — admin
  router.delete('/:id', requireRole('admin'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.catalogue.archive(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #50 import — admin, 5/hr per workspace, ≤ 1 MB CSV body (5000 rows)
  router.post(
    '/import',
    requireRole('admin'),
    rateLimit(deps.redis, { keyFn: (req) => `import:${req.params['workspaceId']}`, limit: 5, windowSeconds: 3600 }),
    (req, res, next) => {
      void (async () => {
        // Body arrives as { fileName, content } JSON; multipart lands with the
        // storage integration (flagged in the service). Content is base64 or raw.
        const body = req.body as { fileName?: string; content?: string; encoding?: 'base64' | 'utf8' }
        if (!body?.fileName || !body?.content) {
          throw new AppError('VALIDATION_FAILED', 'fileName and content are required.')
        }
        const buffer = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')
        if (buffer.length > 1_048_576) throw new AppError('VALIDATION_FAILED', 'CSV exceeds 1 MB.')

        const result = await deps.catalogue.startImport(req.tenant!, body.fileName, buffer)
        if (!result.ok) throw result.error
        await deps.enqueueImport({
          workspaceId: req.tenant!.workspaceId,
          requestId: req.requestId,
          payload: { importId: result.value.importId },
        })
        res.status(202).json({ data: result.value })
      })().catch(next)
    },
  )

  return router
}

export function importsRouter(deps: { catalogue: CatalogueService }): Router {
  const router = Router({ mergeParams: true })

  // #51
  router.get('/:id', requireRole('admin'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.catalogue.getImport(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #52
  router.post('/:id/cancel', requireRole('admin'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.catalogue.cancelImport(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  return router
}

export function knowledgeRouter(deps: { knowledge: KnowledgeService }): Router {
  const router = Router({ mergeParams: true })

  // #53 list — viewer
  router.get('/', requireRole('viewer'), validate({ query: ListKnowledgeQuery }), (req, res, next) => {
    void (async () => {
      const q = req.query as z.infer<typeof ListKnowledgeQuery>
      const result = await deps.knowledge.list(req.tenant!, {
        ...(q.status && { status: q.status }),
        ...(q.category && { category: q.category }),
        ...(q.cursor && { cursor: q.cursor }),
        ...(q.limit && { limit: q.limit }),
      })
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #54 create — admin
  router.post('/', requireRole('admin'), validate({ body: CreateKnowledgeBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.knowledge.create(req.tenant!, req.body as z.infer<typeof CreateKnowledgeBody>)
      if (!result.ok) throw result.error
      res.status(201).json({ data: result.value })
    })().catch(next)
  })

  // #55 update — admin + If-Match
  router.patch('/:id', requireRole('admin'), validate({ params: idParam, body: UpdateKnowledgeBody }), (req, res, next) => {
    void (async () => {
      const expected = requireIfMatch(req.header('If-Match'))
      const result = await deps.knowledge.update(
        req.tenant!, req.params['id'] as string, expected, req.body as z.infer<typeof UpdateKnowledgeBody>,
      )
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #56 DELETE = archive — admin
  router.delete('/:id', requireRole('admin'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.knowledge.archive(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #57 approve — admin
  router.post('/:id/approve', requireRole('admin'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.knowledge.approve(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  return router
}
