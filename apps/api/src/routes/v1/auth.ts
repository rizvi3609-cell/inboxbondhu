/**
 * Auth routes (§7.1 #5–12, §7.2 #13–20) — THIN. Cookie handling per §8.2:
 * ib_at (15 min, Path=/), ib_rt (30 d, Path=/api/v1/auth), ib_csrf (JS-readable).
 */
import { Router, type Request, type Response } from 'express'
import type { Redis } from 'ioredis'
import {
  AppError, IdentityService, User, hashIp,
} from '@inboxbondhu/core'
import {
  DeactivateMeBody, ForgotPasswordBody, LoginBody, RegisterBody,
  RequestUnlockOtpBody, ResendVerificationBody, ResetPasswordBody,
  UpdateMeBody, VerifyEmailBody, VerifyUnlockOtpBody,
} from '@inboxbondhu/contracts'
import { auth, csrf, rateLimit, validate } from '../../middleware/core.js'

export interface AuthRouterDeps {
  identity: IdentityService
  redis: Redis | null
  jwtSecret: string
  jwtSecretPrevious?: string
  pepper: string
  secureCookies: boolean
}

function setSessionCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string; csrfToken: string },
  secure: boolean,
): void {
  const base = { httpOnly: true, secure, sameSite: 'strict' as const }
  res.cookie('ib_at', tokens.accessToken, { ...base, path: '/', maxAge: 15 * 60_000 })
  res.cookie('ib_rt', tokens.refreshToken, { ...base, path: '/api/v1/auth', maxAge: 30 * 86_400_000 })
  res.cookie('ib_csrf', tokens.csrfToken, { httpOnly: false, secure, sameSite: 'strict', path: '/' })
}

function clearSessionCookies(res: Response): void {
  res.clearCookie('ib_at', { path: '/' })
  res.clearCookie('ib_rt', { path: '/api/v1/auth' })
  res.clearCookie('ib_csrf', { path: '/' })
}

function device(req: Request, pepper: string): { userAgent: string; ipHash: string } {
  return {
    userAgent: req.header('user-agent') ?? 'unknown',
    ipHash: hashIp(req.ip ?? '0.0.0.0', pepper),
  }
}

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router()
  const { identity, redis, pepper } = deps

  // #5 register — 3/hr per IP
  router.post(
    '/register',
    rateLimit(redis, { keyFn: (req) => `register:${req.ip}`, limit: 3, windowSeconds: 3600 }),
    validate({ body: RegisterBody }),
    (req, res, next) => {
      void (async () => {
        const result = await identity.register({ ...req.body, requestId: req.requestId })
        if (!result.ok) throw result.error
        // 201, NO session — login blocked until verified (§9 Phase 2 item 1).
        res.status(201).json({ data: { userId: result.value.userId, workspaceId: result.value.workspaceId } })
      })().catch(next)
    },
  )

  // #7 verify-email
  router.post('/verify-email', validate({ body: VerifyEmailBody }), (req, res, next) => {
    void (async () => {
      const result = await identity.verifyEmail((req.body as { token: string }).token)
      if (!result.ok) throw result.error
      res.status(200).json({ data: { verified: true } })
    })().catch(next)
  })

  // #8 resend-verification — 3/hr; generic response
  router.post(
    '/resend-verification',
    rateLimit(redis, { keyFn: (req) => `resend:${(req.body as { email?: string })?.email ?? req.ip}`, limit: 3, windowSeconds: 3600 }),
    validate({ body: ResendVerificationBody }),
    (_req, res) => {
      // Outbox retry of the original event is the actual mechanism; the
      // endpoint always answers generically (no enumeration).
      res.status(202).json({ data: { message: 'If the account exists, a verification email has been sent.' } })
    },
  )

  // #6 login — 5/15 min per IP+email
  router.post(
    '/login',
    rateLimit(redis, {
      keyFn: (req) => `login:${req.ip}:${(req.body as { email?: string })?.email ?? ''}`,
      limit: 5,
      windowSeconds: 900,
    }),
    validate({ body: LoginBody }),
    (req, res, next) => {
      void (async () => {
        const body = req.body as { email: string; password: string }
        const result = await identity.login({ ...body, device: device(req, pepper) })
        if (!result.ok) throw result.error
        setSessionCookies(res, result.value, deps.secureCookies)
        res.status(200).json({
          data: { userId: result.value.userId, evictedSessionId: result.value.evictedSessionId },
        })
      })().catch(next)
    },
  )

  // #13 refresh — refresh cookie only (Path=/api/v1/auth)
  router.post('/refresh', (req, res, next) => {
    void (async () => {
      const raw = (req.cookies as Record<string, string | undefined>)['ib_rt']
      if (!raw) throw new AppError('UNAUTHENTICATED', 'No refresh token.')
      const result = await identity.refresh(raw, device(req, pepper))
      if (!result.ok) {
        clearSessionCookies(res)
        throw result.error
      }
      setSessionCookies(res, result.value, deps.secureCookies)
      res.status(200).json({ data: { userId: result.value.userId } })
    })().catch(next)
  })

  // #9/#10 forgot/reset password
  router.post(
    '/forgot-password',
    rateLimit(redis, { keyFn: (req) => `forgot:${(req.body as { email?: string })?.email ?? req.ip}`, limit: 3, windowSeconds: 3600 }),
    validate({ body: ForgotPasswordBody }),
    (req, res, next) => {
      void (async () => {
        await identity.forgotPassword((req.body as { email: string }).email)
        // Generic success prevents enumeration (PRD §2.1).
        res.status(202).json({ data: { message: 'If the account exists, a reset email has been sent.' } })
      })().catch(next)
    },
  )

  router.post('/reset-password', validate({ body: ResetPasswordBody }), (req, res, next) => {
    void (async () => {
      const body = req.body as { token: string; password: string }
      const result = await identity.resetPassword(body.token, body.password)
      if (!result.ok) throw result.error
      res.status(200).json({ data: { message: 'Password updated. Sign in with your new password.' } })
    })().catch(next)
  })

  // #11/#12 OTP unlock
  router.post(
    '/unlock/request-otp',
    rateLimit(redis, { keyFn: (req) => `otp:${(req.body as { email?: string })?.email ?? req.ip}`, limit: 3, windowSeconds: 3600 }),
    validate({ body: RequestUnlockOtpBody }),
    (req, res, next) => {
      void (async () => {
        await identity.requestUnlockOtp((req.body as { email: string }).email)
        res.status(202).json({ data: { message: 'If the account exists, an OTP has been sent.' } })
      })().catch(next)
    },
  )

  router.post('/unlock/verify-otp', validate({ body: VerifyUnlockOtpBody }), (req, res, next) => {
    void (async () => {
      const body = req.body as { email: string; otp: string }
      const result = await identity.verifyUnlockOtp(body.email, body.otp)
      if (!result.ok) throw result.error
      res.status(200).json({ data: { unlocked: true } })
    })().catch(next)
  })

  // ── Session-scoped (S) — #14–20 ────────────────────────────────────────────
  const requireAuth = auth(deps.jwtSecret, deps.jwtSecretPrevious)
  const requireCsrf = csrf()

  router.post('/logout', requireAuth, requireCsrf, (req, res, next) => {
    void (async () => {
      await identity.logout(req.auth!.sessionId, req.auth!.userId)
      clearSessionCookies(res)
      res.status(200).json({ data: { loggedOut: true } })
    })().catch(next)
  })

  router.post('/logout-all', requireAuth, requireCsrf, (req, res, next) => {
    void (async () => {
      const result = await identity.logoutAll(req.auth!.userId)
      if (!result.ok) throw result.error
      clearSessionCookies(res)
      res.status(200).json({ data: { revoked: result.value.revoked } })
    })().catch(next)
  })

  return router
}

/** /me routes (§7.2 #16–20) — separate router mounted at /api/v1/me. */
export function meRouter(deps: AuthRouterDeps): Router {
  const router = Router()
  const requireAuth = auth(deps.jwtSecret, deps.jwtSecretPrevious)
  const requireCsrf = csrf()

  router.get('/', requireAuth, (req, res, next) => {
    void (async () => {
      const user = await User.findOne({ _id: req.auth!.userId }).exec()
      if (!user) throw new AppError('NOT_FOUND', 'Account not found.')
      res.json({
        data: {
          id: String(user._id),
          email: user.email,
          name: user.name,
          phone: user.phone,
          emailVerified: user.emailVerifiedAt !== null,
          lastLoginAt: user.lastLoginAt,
        },
      })
    })().catch(next)
  })

  router.patch('/', requireAuth, requireCsrf, validate({ body: UpdateMeBody }), (req, res, next) => {
    void (async () => {
      const updates = req.body as Record<string, unknown>
      if (Object.keys(updates).length === 0) {
        throw new AppError('VALIDATION_FAILED', 'Nothing to update.')
      }
      await User.updateOne({ _id: req.auth!.userId }, { $set: updates }).exec()
      res.json({ data: { updated: true } })
    })().catch(next)
  })

  router.get('/sessions', requireAuth, (req, res, next) => {
    void (async () => {
      const { Session } = await import('@inboxbondhu/core')
      const sessions = await Session.find({ userId: req.auth!.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
        .sort({ lastUsedAt: -1 })
        .exec()
      res.json({
        data: sessions.map((s) => ({
          id: String(s._id),
          userAgent: s.userAgent,
          lastUsedAt: s.lastUsedAt,
          createdAt: (s as unknown as { createdAt: Date }).createdAt,
          current: String(s._id) === req.auth!.sessionId,
        })),
      })
    })().catch(next)
  })

  router.delete('/sessions/:id', requireAuth, requireCsrf, (req, res, next) => {
    void (async () => {
      const { Session } = await import('@inboxbondhu/core')
      const result = await Session.updateOne(
        { _id: req.params['id'], userId: req.auth!.userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
      ).exec()
      if (result.matchedCount === 0) throw new AppError('NOT_FOUND', 'Session not found.')
      res.json({ data: { revoked: true } })
    })().catch(next)
  })

  router.post('/deactivate', requireAuth, requireCsrf, validate({ body: DeactivateMeBody }), (req, res, next) => {
    void (async () => {
      const result = await deps.identity.deactivate(req.auth!.userId, (req.body as { password: string }).password)
      if (!result.ok) throw result.error
      res.json({ data: { deactivated: true } })
    })().catch(next)
  })

  return router
}
