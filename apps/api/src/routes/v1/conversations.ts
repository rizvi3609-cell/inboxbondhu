/**
 * Inbox routes (§7.3 #40–45) — THIN. Viewer can read; agent+ mutates.
 * #42 requires If-Match (428/409 discipline); #44 requires Idempotency-Key
 * (missing → 428; replay → 200 with the original body, never 201).
 */
import { Router } from 'express'
import { z } from 'zod'
import { AppError, type InboxService } from '@inboxbondhu/core'
import {
  ListConversationsQuerySchema, ListMessagesQuerySchema,
  SendMessageBody, UpdateConversationBody, objectIdString,
} from '@inboxbondhu/contracts'
import { requireRole, validate } from '../../middleware/core.js'

const idParam = z.object({ id: objectIdString }).passthrough()

export function conversationsRouter(deps: { inbox: InboxService }): Router {
  const router = Router({ mergeParams: true })

  // #40 list — viewer
  router.get('/', requireRole('viewer'), validate({ query: ListConversationsQuerySchema }), (req, res, next) => {
    void (async () => {
      const q = req.query as z.infer<typeof ListConversationsQuerySchema>
      const result = await deps.inbox.list(req.tenant!, {
        ...(q.status && { status: q.status }),
        ...(q.mode && { mode: q.mode }),
        ...(q.assignedTo && { assignedTo: q.assignedTo }),
        ...(q.channelId && { channelId: q.channelId }),
        ...(q.q && { q: q.q }),
        ...(q.updatedSince && { updatedSince: q.updatedSince }),
        ...(q.cursor && { cursor: q.cursor }),
        ...(q.limit && { limit: q.limit }),
      })
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #41 get one — viewer (PII nulled for viewer in the service)
  router.get('/:id', requireRole('viewer'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.inbox.get(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #43 messages — viewer (viewer read does NOT clear unread)
  router.get('/:id/messages', requireRole('viewer'), validate({ params: idParam, query: ListMessagesQuerySchema }), (req, res, next) => {
    void (async () => {
      const q = req.query as { cursor?: string; limit?: number }
      const result = await deps.inbox.listMessages(req.tenant!, req.params['id'] as string, {
        ...(q.cursor && { cursor: q.cursor }),
        ...(q.limit && { limit: q.limit }),
      })
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #42 update — agent + If-Match
  router.patch('/:id', requireRole('agent'), validate({ params: idParam, body: UpdateConversationBody }), (req, res, next) => {
    void (async () => {
      const ifMatch = req.header('If-Match')
      if (ifMatch === undefined) {
        throw new AppError('PRECONDITION_REQUIRED', 'If-Match header required.') // 428, never 400/409
      }
      const expected = Number(ifMatch)
      if (!Number.isInteger(expected) || expected < 0) {
        throw new AppError('VALIDATION_FAILED', 'If-Match must be a non-negative integer version.')
      }
      const result = await deps.inbox.update(
        req.tenant!, req.params['id'] as string, expected,
        req.body as z.infer<typeof UpdateConversationBody>,
      )
      if (!result.ok) throw result.error
      res.json({ data: { updated: true, version: result.value.version } })
    })().catch(next)
  })

  // #44 send message — agent + Idempotency-Key
  router.post('/:id/messages', requireRole('agent'), validate({ params: idParam, body: SendMessageBody }), (req, res, next) => {
    void (async () => {
      const key = req.header('Idempotency-Key')
      if (!key) {
        throw new AppError('PRECONDITION_REQUIRED', 'Idempotency-Key header required.') // 428
      }
      if (key.length < 8 || key.length > 128) {
        throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 8–128 characters.')
      }
      const result = await deps.inbox.sendMessage(
        req.tenant!, req.params['id'] as string, key, (req.body as { text: string }).text,
      )
      if (!result.ok) throw result.error
      // Replay → 200 with the original body, never 201.
      res.status(result.value.replayed ? 200 : 201).json({
        data: { messageId: result.value.messageId, replayed: result.value.replayed },
      })
    })().catch(next)
  })

  return router
}

/** #45 POST /messages/:id/retry — mounted at /w/:workspaceId/messages. */
export function messagesRouter(deps: { inbox: InboxService }): Router {
  const router = Router({ mergeParams: true })
  router.post('/:id/retry', requireRole('agent'), validate({ params: idParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.inbox.retryMessage(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })
  return router
}
