/**
 * Workspace routes (§7.2 #21–23, §7.3 #25–34) — THIN handlers only.
 * Every /w/:workspaceId route passes tenant() → 403 WORKSPACE_FORBIDDEN for
 * non-members (MVP gate #8).
 */
import { Router } from 'express'
import type { Redis } from 'ioredis'
import { z } from 'zod'
import {
  AppError, Invitation, Membership, User, Workspace, WorkspaceService,
  occFilter, throwVersionConflict,
} from '@inboxbondhu/core'
import {
  ChangeRoleBody, CreateInvitationBody, CreateWorkspaceBody,
  TransferOwnershipBody, UpdateWorkspaceBody, objectIdString,
} from '@inboxbondhu/contracts'
import { auth, csrf, rateLimit, requireRole, tenant, validate } from '../../middleware/core.js'

export interface WorkspaceRouterDeps {
  workspace: WorkspaceService
  redis: Redis | null
  jwtSecret: string
  jwtSecretPrevious?: string
}

const memberParam = z.object({ workspaceId: objectIdString, id: objectIdString }).passthrough()

export function workspacesRouter(deps: WorkspaceRouterDeps): Router {
  const router = Router()
  const requireAuth = auth(deps.jwtSecret, deps.jwtSecretPrevious)
  const requireCsrf = csrf()
  const requireTenant = tenant(deps.redis)

  // ── Session-scoped (no workspace context) ────────────────────────────────

  // #21 list my workspaces
  router.get('/workspaces', requireAuth, (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.listForUser(req.auth!.userId)
      if (!result.ok) throw result.error
      res.json({ data: result.value })
    })().catch(next)
  })

  // #22 create workspace
  router.post('/workspaces', requireAuth, requireCsrf, validate({ body: CreateWorkspaceBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.create(req.auth!.userId, (req.body as { name: string }).name)
      if (!result.ok) throw result.error
      res.status(201).json({ data: result.value })
    })().catch(next)
  })

  // #23 accept invitation — requires VERIFIED email (enforced in service)
  router.post(
    '/invitations/:token/accept',
    requireAuth,
    requireCsrf,
    validate({ params: z.object({ token: z.string().min(32).max(128) }).passthrough() }),
    (req, res, next) => {
      void (async () => {
        const result = await deps.workspace.acceptInvitation(req.auth!.userId, req.params['token'] as string)
        if (!result.ok) throw result.error
        res.status(200).json({ data: result.value })
      })().catch(next)
    },
  )

  // ── Workspace-scoped: /w/:workspaceId ─────────────────────────────────────

  const w = Router({ mergeParams: true })
  router.use('/w/:workspaceId', requireAuth, requireCsrf, requireTenant, w)

  // #25 GET / — viewer
  w.get('/', requireRole('viewer'), (req, res, next) => {
    void (async () => {
      const ws = await Workspace.findOne({ _id: req.tenant!.workspaceId }).exec()
      if (!ws) throw new AppError('NOT_FOUND', 'Workspace not found.')
      res.json({
        data: {
          id: String(ws._id), name: ws.name, slug: ws.slug, plan: ws.plan,
          status: ws.status, timezone: ws.timezone, currency: ws.currency,
          businessHours: ws.businessHours, aiConfig: ws.aiConfig,
          deliveryZones: ws.deliveryZones, version: ws.version,
        },
      })
    })().catch(next)
  })

  // #26 PATCH / — admin + If-Match (OCC)
  w.patch('/', requireRole('admin'), validate({ body: UpdateWorkspaceBody }), (req, res, next) => {
    void (async () => {
      const ifMatch = req.header('If-Match')
      if (ifMatch === undefined) {
        throw new AppError('PRECONDITION_REQUIRED', 'If-Match header required.') // 428, never 400/409
      }
      const expected = Number(ifMatch)
      if (!Number.isInteger(expected) || expected < 0) {
        throw new AppError('VALIDATION_FAILED', 'If-Match must be a non-negative integer version.')
      }
      const updates = req.body as Record<string, unknown>
      const result = await Workspace.updateOne(
        { _id: req.tenant!.workspaceId, ...occFilter(expected) },
        { $set: updates },
      ).exec()
      if (result.matchedCount === 0) {
        const fresh = await Workspace.findOne({ _id: req.tenant!.workspaceId }).exec()
        if (!fresh) throw new AppError('NOT_FOUND', 'Workspace not found.')
        throwVersionConflict(fresh.version, Object.keys(updates)) // 409 + currentVersion
      }
      res.json({ data: { updated: true, version: expected + 1 } })
    })().catch(next)
  })

  // #27 transfer ownership — OWNER + password
  w.post('/transfer-ownership', requireRole('owner'), validate({ body: TransferOwnershipBody }), (req, res, next) => {
    void (async () => {
      const body = req.body as { password: string; targetUserId: string }
      const result = await deps.workspace.transferOwnership(req.tenant!, body.password, body.targetUserId)
      if (!result.ok) throw result.error
      res.json({ data: { transferred: true } })
    })().catch(next)
  })

  // #28 deactivate — OWNER
  w.post('/deactivate', requireRole('owner'), (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.deactivateWorkspace(req.tenant!)
      if (!result.ok) throw result.error
      res.json({ data: { deactivated: true } })
    })().catch(next)
  })

  // #29 members list — admin
  w.get('/members', requireRole('admin'), (req, res, next) => {
    void (async () => {
      const members = await Membership.find({ workspaceId: req.tenant!.workspaceId, removedAt: null }).exec()
      const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).exec()
      const byId = new Map(users.map((u) => [String(u._id), u]))
      res.json({
        data: members.map((m) => {
          const u = byId.get(String(m.userId))
          return {
            userId: String(m.userId), role: m.role, joinedAt: m.joinedAt,
            name: u?.name ?? null, email: u?.email ?? null,
          }
        }),
      })
    })().catch(next)
  })

  // #30 change role — admin (owner-guard in service)
  w.patch('/members/:id', requireRole('admin'), validate({ params: memberParam, body: ChangeRoleBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.changeRole(
        req.tenant!, req.params['id'] as string, (req.body as { role: 'admin' | 'agent' | 'viewer' }).role,
      )
      if (!result.ok) throw result.error
      res.json({ data: { changed: true } })
    })().catch(next)
  })

  // #31 remove member — admin (T2 cascade)
  w.delete('/members/:id', requireRole('admin'), validate({ params: memberParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.removeMember(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: { removed: true } })
    })().catch(next)
  })

  // #32 invitations list — admin
  w.get('/invitations', requireRole('admin'), (req, res, next) => {
    void (async () => {
      const invitations = await Invitation.find({ workspaceId: req.tenant!.workspaceId, status: 'pending' }).exec()
      res.json({
        data: invitations.map((i) => ({
          id: String(i._id), email: i.email, role: i.role, expiresAt: i.expiresAt,
        })),
      })
    })().catch(next)
  })

  // #33 create invitation — admin
  w.post(
    '/invitations',
    requireRole('admin'),
    rateLimit(deps.redis, { keyFn: (req) => `invite:${req.params['workspaceId']}`, limit: 20, windowSeconds: 3600 }),
    validate({ body: CreateInvitationBody }),
    (req, res, next) => {
      void (async () => {
        const body = req.body as { email: string; role: 'admin' | 'agent' | 'viewer' }
        const result = await deps.workspace.invite(req.tenant!, body.email, body.role)
        if (!result.ok) throw result.error
        res.status(201).json({ data: { invitationId: result.value.invitationId } })
      })().catch(next)
    },
  )

  // #34 revoke invitation — admin
  w.delete('/invitations/:id', requireRole('admin'), validate({ params: memberParam }), (req, res, next) => {
    void (async () => {
      const result = await deps.workspace.revokeInvitation(req.tenant!, req.params['id'] as string)
      if (!result.ok) throw result.error
      res.json({ data: { revoked: true } })
    })().catch(next)
  })

  return router
}
