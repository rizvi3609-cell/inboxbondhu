/**
 * §8.1 items 2, 3, 6 — Phase 9 hardening.
 *
 *  2  helmet + CSP nonce   — nonce-based CSP per ADR-012 (the PRD's literal
 *                            `script-src 'self'` breaks Next.js hydration;
 *                            'nonce-{r}' + 'strict-dynamic' is STRICTER).
 *  3  cors                 — APP_URL only, credentials: true.
 *  6  degradedMode         — Mongo down: allow webhook + /healthz (both are
 *                            mounted in front of this), everything else 503
 *                            DEGRADED_MODE. Losing a customer message is
 *                            unacceptable; being unable to answer is survivable.
 */
import { randomBytes } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import helmet from 'helmet'
import mongoose from 'mongoose'

declare module 'express-serve-static-core' {
  interface Locals {
    cspNonce?: string
  }
}

/**
 * helmet defaults + per-request CSP nonce (ADR-012 / PRD §4.1).
 * The nonce is fresh per response; consumers read `res.locals.cspNonce`.
 * connect-src allows same-origin plus the wss origin from the PRD policy.
 */
export function securityHeaders(opts: { wssOrigin?: string } = {}) {
  const base = helmet({
    contentSecurityPolicy: false, // we set CSP ourselves — helmet's static CSP cannot carry a per-request nonce
    crossOriginEmbedderPolicy: false, // profile pics come from Meta's CDN (img-src https:)
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
  })
  const wss = opts.wssOrigin ?? 'wss://*.inboxbondhu.me'
  return (req: Request, res: Response, next: NextFunction): void => {
    base(req, res, (err?: unknown) => {
      if (err) return next(err)
      const nonce = randomBytes(16).toString('base64')
      res.locals.cspNonce = nonce
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
          `connect-src 'self' ${wss}`,
          "img-src 'self' https: data:",
          "style-src 'self' 'unsafe-inline'",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
        ].join('; '),
      )
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      next()
    })
  }
}

/**
 * CORS — APP_URL only, credentials: true (§8.1 item 3). Deliberately manual:
 * one allowed origin, no wildcard, Vary: Origin for caches. A disallowed
 * Origin gets NO CORS headers (the browser blocks it) — the request itself
 * still runs auth/csrf, which is the real control.
 */
export function cors(appUrl: string) {
  const allowed = appUrl.replace(/\/+$/, '')
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header('Origin')
    res.setHeader('Vary', 'Origin')
    if (origin && origin.replace(/\/+$/, '') === allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, X-CSRF-Token, If-Match, Idempotency-Key, X-Request-Id',
        )
        res.setHeader('Access-Control-Max-Age', '600')
        res.status(204).end()
        return
      }
    }
    next()
  }
}

/**
 * Degraded mode (§14.1). Sits AFTER the webhook mount and /healthz//readyz,
 * BEFORE auth: when Mongo is unreachable every other route answers
 * 503 DEGRADED_MODE immediately instead of stalling 5 s in server selection.
 * The probe is the driver's readyState — no I/O on the request path.
 */
export function degradedMode() {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (mongoose.connection.readyState === 1) return next()
    res.status(503).json({
      error: {
        code: 'DEGRADED_MODE',
        message: 'The service is temporarily degraded (database unreachable). Incoming customer messages are still being received and buffered.',
      },
    })
  }
}
