/**
 * Phase 9 hardening tests — §8.1 items 2/3/6 + §14.1:
 * - degraded mode: Mongo down → /healthz 200 {degraded:true}, webhook 200,
 *   EVERY other route 503 DEGRADED_MODE (no 5 s stall)
 * - helmet + nonce CSP: per-request nonce, strict-dynamic, HSTS, the §15.1
 *   header set; the webhook path stays header-free (mounted before)
 * - cors: APP_URL echoed with credentials; foreign origins get nothing;
 *   preflight answers 204 with the exact header allowlist
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mongoose from 'mongoose'
import type { Express } from 'express'
import type { DbClients } from '@inboxbondhu/core'
import { createApp } from '../app.js'
import { dropData, startDb, stopDb } from './setupDb.js'

const APP_SECRET = 'meta-app-secret-p9'
const APP_URL = 'https://app.inboxbondhu.me'

let app: Express

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
}

function metaBody(mid: string): string {
  return JSON.stringify({
    object: 'page',
    entry: [{ id: '108888001', time: Date.now(), messaging: [{ sender: { id: 'psid-9' }, message: { mid, text: 'hi' } }] }],
  })
}

beforeAll(async () => {
  await startDb()
  await dropData()
  // A createApp with clients present (degradedMode arms itself) but a fake
  // DbClients — these tests never call /readyz's redis path.
  const fakeClients = { mongoose, redis: null as never } as unknown as DbClients
  app = createApp({
    clients: fakeClients,
    version: 'p9-test',
    startedAt: Date.now(),
    security: { appUrl: APP_URL },
    webhook: {
      redis: null,
      appSecret: APP_SECRET,
      verifyToken: 'vt-p9',
      journalDir: mkdtempSync(join(tmpdir(), 'ib-p9-journal-')),
      enqueue: async () => undefined,
    },
    auth: {
      jwtSecret: 'p9-jwt-secret-0123456789abcdef-xyz',
      pepper: 'p9-pepper-0123456789',
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      maxSessions: 5,
      secureCookies: false,
    },
  })
}, 300_000)

afterAll(async () => {
  await stopDb()
})

describe('security headers (§8.1 item 2 — helmet + CSP nonce)', () => {
  it('every API response carries the nonce CSP + the §15.1 header set', async () => {
    const res = await request(app).get('/healthz')
    const csp = res.headers['content-security-policy']!
    expect(csp).toContain("default-src 'self'")
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/)
    expect(csp).toContain('wss://*.inboxbondhu.me')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(res.headers['permissions-policy']).toContain('camera=()')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('the nonce is fresh per request', async () => {
    const nonce = (h: string) => /'nonce-([^']+)'/.exec(h)![1]
    const a = await request(app).get('/healthz')
    const b = await request(app).get('/healthz')
    expect(nonce(a.headers['content-security-policy']!)).not.toBe(
      nonce(b.headers['content-security-policy']!),
    )
  })

  it('the webhook path is mounted BEFORE the header/CORS stack (≤500 ms budget untouched)', async () => {
    const body = metaBody('mid.p9-headers')
    const res = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body)
    expect(res.status).toBe(200)
    expect(res.headers['content-security-policy']).toBeUndefined()
  })
})

describe('cors (§8.1 item 3 — APP_URL only, credentials)', () => {
  it('the configured APP_URL origin is allowed with credentials', async () => {
    const res = await request(app).get('/healthz').set('Origin', APP_URL)
    expect(res.headers['access-control-allow-origin']).toBe(APP_URL)
    expect(res.headers['access-control-allow-credentials']).toBe('true')
    expect(res.headers['vary']).toContain('Origin')
  })

  it('a foreign origin gets NO CORS headers', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://evil.example')
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('preflight answers 204 with the exact mutation-header allowlist', async () => {
    const res = await request(app)
      .options('/api/v1/me')
      .set('Origin', APP_URL)
      .set('Access-Control-Request-Method', 'PATCH')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('PATCH')
    const allowed = res.headers['access-control-allow-headers']!
    for (const h of ['X-CSRF-Token', 'If-Match', 'Idempotency-Key']) {
      expect(allowed).toContain(h)
    }
  })
})

describe('degraded mode (§8.1 item 6 + §14.1) — Mongo down', () => {
  it('the §14.1 table, row by row', async () => {
    await mongoose.disconnect()
    try {
      // Row 1 — POST /webhooks/meta: still 200, fast (journal fallback).
      const body = metaBody('mid.p9-degraded')
      const t0 = performance.now()
      const wh = await request(app)
        .post('/webhooks/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body))
        .send(body)
      expect(wh.status).toBe(200)
      expect(performance.now() - t0).toBeLessThan(500)

      // Row 2 — GET /healthz: 200 with degraded: true.
      const hz = await request(app).get('/healthz')
      expect(hz.status).toBe(200)
      expect(hz.body.data.degraded).toBe(true)

      // Row 4 — everything else: 503 DEGRADED_MODE, instantly (no 5 s
      // serverSelection stall — the probe is readyState, not I/O).
      const t1 = performance.now()
      const me = await request(app).get('/api/v1/me')
      expect(performance.now() - t1).toBeLessThan(500)
      expect(me.status).toBe(503)
      expect(me.body.error.code).toBe('DEGRADED_MODE')

      const login = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'x@x.example', password: 'irrelevant-123' })
      expect(login.status).toBe(503)
      expect(login.body.error.code).toBe('DEGRADED_MODE')
    } finally {
      // Reconnect for the suites that follow in this shared process.
      await startDb()
    }
  })

  it('recovery: once Mongo is back the same routes stop returning 503', async () => {
    const hz = await request(app).get('/healthz')
    expect(hz.body.data.degraded).toBe(false)
    const me = await request(app).get('/api/v1/me')
    expect(me.status).toBe(401) // UNAUTHENTICATED — normal middleware resumed
  })
})
