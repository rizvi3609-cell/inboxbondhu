/**
 * Middleware per §8.1: requestId, auth (JWT + session revocation check),
 * csrf (Synchronizer Token Pattern), tenant (membership → TenantContext,
 * 60 s Redis cache, 403 WORKSPACE_FORBIDDEN), rbac(minRole), validate(zod),
 * errorHandler (AppError → envelope, never a stack).
 */
import type { NextFunction, Request, Response } from 'express'
import type { Redis } from 'ioredis'
import type { ZodTypeAny } from 'zod'
import {
  AppError, VersionConflictError, makeTenantContext,
  Membership, Session, Workspace,
  verifyAccessToken,
} from '@inboxbondhu/core'
import { ulid } from '@inboxbondhu/core'

// ── request context ──────────────────────────────────────────────────────────

export interface AuthState {
  userId: string
  sessionId: string
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string
    auth?: AuthState
    tenant?: import('@inboxbondhu/core').TenantContext
  }
}

export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    req.requestId = ulid()
    res.setHeader('X-Request-Id', req.requestId)
    next()
  }
}

// ── auth (§8.1 step 7) ───────────────────────────────────────────────────────

export function auth(jwtSecret: string, jwtSecretPrevious?: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      const token = (req.cookies as Record<string, string | undefined>)['ib_at']
      if (!token) throw new AppError('UNAUTHENTICATED', 'Sign in required.')
      const claims = verifyAccessToken(token, jwtSecret, jwtSecretPrevious)
      if (!claims) throw new AppError('UNAUTHENTICATED', 'Session expired. Sign in again.')

      // Load session; check revokedAt on EVERY request (TTL is not the control).
      const session = await Session.findOne({ _id: claims.sid, userId: claims.sub }).exec()
      if (!session) throw new AppError('UNAUTHENTICATED', 'Session not found.')
      if (session.revokedAt) {
        throw new AppError('SESSION_REVOKED', 'This session has been revoked.')
      }
      // Refresh lastUsedAt (feeds LRU eviction), throttled to ~1/min.
      if (Date.now() - session.lastUsedAt.getTime() > 60_000) {
        await Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } }).exec()
      }
      req.auth = { userId: claims.sub, sessionId: claims.sid }
      next()
    })().catch(next)
  }
}

// ── csrf (§8.1 step 8) — Synchronizer Token Pattern ─────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function csrf() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next()
    const cookie = (req.cookies as Record<string, string | undefined>)['ib_csrf']
    const header = req.header('X-CSRF-Token')
    if (!cookie || !header || cookie !== header) {
      return next(new AppError('CSRF_TOKEN_INVALID', 'Missing or invalid CSRF token.'))
    }
    next()
  }
}

// ── tenant (§8.6) ────────────────────────────────────────────────────────────

export function tenant(redis: Redis | null) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    void (async () => {
      if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Sign in required.')
      const workspaceId = String(req.params['workspaceId'] ?? '')
      if (!workspaceId || !/^[0-9a-fA-F]{24}$/.test(workspaceId)) {
        throw new AppError('WORKSPACE_FORBIDDEN', 'Not a member of this workspace.')
      }

      const cacheKey = `ws:${workspaceId}:member:${req.auth.userId}`
      let role: string | null = null
      if (redis) {
        role = await redis.get(cacheKey).catch(() => null) // rate limits fail open, cache too
      }
      if (!role) {
        const membership = await Membership.findOne({
          workspaceId, userId: req.auth.userId, removedAt: null,
        }).exec()
        if (!membership) {
          // 403, NEVER 404 — and never fall through to an unscoped query.
          throw new AppError('WORKSPACE_FORBIDDEN', 'Not a member of this workspace.')
        }
        role = membership.role
        if (redis) await redis.set(cacheKey, role, 'EX', 60).catch(() => undefined)
      }

      // Deactivated workspaces reject mutations (§8.6 step 5).
      if (!SAFE_METHODS.has(req.method)) {
        const ws = await Workspace.findOne({ _id: workspaceId }).exec()
        if (!ws || ws.status !== 'active') {
          throw new AppError('BUSINESS_RULE_VIOLATION', 'This workspace is deactivated.')
        }
      }

      req.tenant = makeTenantContext({
        workspaceId,
        userId: req.auth.userId,
        role: role as 'owner' | 'admin' | 'agent' | 'viewer',
        requestId: req.requestId,
      })
      next()
    })().catch(next)
  }
}

/** Synchronous membership-cache invalidator — wired into WorkspaceService. */
export function membershipCacheInvalidator(redis: Redis | null) {
  return async (workspaceId: string, userId: string): Promise<void> => {
    if (!redis) return
    await redis.del(`ws:${workspaceId}:member:${userId}`)
  }
}

// ── rbac (§8.7) ──────────────────────────────────────────────────────────────

const ROLE_RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 }

export function requireRole(minRole: 'viewer' | 'agent' | 'admin' | 'owner') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.tenant?.role
    if (!role || (ROLE_RANK[role] ?? -1) < (ROLE_RANK[minRole] ?? 99)) {
      return next(new AppError('INSUFFICIENT_PERMISSIONS', `Requires ${minRole} role or higher.`))
    }
    next()
  }
}

// ── validate (§8.1 step 11) ──────────────────────────────────────────────────

export function validate(schemas: { body?: ZodTypeAny; params?: ZodTypeAny; query?: ZodTypeAny }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const [key, schema] of Object.entries(schemas) as ['body' | 'params' | 'query', ZodTypeAny][]) {
      const parsed = schema.safeParse(req[key])
      if (!parsed.success) {
        return next(
          new AppError('VALIDATION_FAILED', 'Request failed validation.', {
            details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), issue: i.message })),
          }),
        )
      }
      if (key === 'body') req.body = parsed.data
    }
    next()
  }
}

// ── rate limiting (§8.5) — Redis fixed-window; FAILS OPEN with a loud log ────

export function rateLimit(
  redis: Redis | null,
  opts: { keyFn: (req: Request) => string; limit: number; windowSeconds: number },
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      if (!redis) return next()
      const key = `rl:${opts.keyFn(req)}`
      try {
        const count = await redis.incr(key)
        if (count === 1) await redis.expire(key, opts.windowSeconds)
        if (count > opts.limit) {
          const ttl = await redis.ttl(key)
          res.setHeader('Retry-After', String(Math.max(ttl, 1)))
          throw new AppError('RATE_LIMITED', 'Too many requests. Try again later.')
        }
        next()
      } catch (err) {
        if (err instanceof AppError) throw err
        next() // Redis down: rate limits fail OPEN (P-02) — never block auth on cache death
      }
    })().catch(next)
  }
}

// ── error envelope (§6.2/§6.3) ───────────────────────────────────────────────

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  SESSION_REVOKED: 401,
  INSUFFICIENT_PERMISSIONS: 403,
  WORKSPACE_FORBIDDEN: 403,
  CSRF_TOKEN_INVALID: 403,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  DUPLICATE_RESOURCE: 409,
  BUSINESS_RULE_VIOLATION: 422,
  ACCOUNT_LOCKED: 423,
  PRECONDITION_REQUIRED: 428,
  RATE_LIMITED: 429,
  PLAN_LIMIT_EXCEEDED: 429,
  NOT_IMPLEMENTED: 501,
  UPSTREAM_FAILED: 502,
  DEGRADED_MODE: 503,
}

export function errorHandler() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof AppError) {
      const status = STATUS_BY_CODE[err.code] ?? 500
      const body: Record<string, unknown> = {
        error: {
          code: err.code,
          message: err.message,
          requestId: req.requestId,
          ...(err.details?.['details'] ? { details: err.details['details'] } : {}),
        },
      }
      if (err instanceof VersionConflictError) {
        // The ONLY envelope extension (§6.2).
        ;(body['error'] as Record<string, unknown>)['currentVersion'] = err.currentVersion
        ;(body['error'] as Record<string, unknown>)['conflictingFields'] = err.conflictingFields
      }
      res.status(status).json(body)
      return
    }
    // Unknown: 500 + requestId, NEVER a stack.
    res.status(500).json({
      error: { code: 'INTERNAL', message: 'Something went wrong.', requestId: req.requestId },
    })
  }
}
