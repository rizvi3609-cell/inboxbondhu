/**
 * Phase 0 DoD: /healthz returns build version + uptime; /readyz pings
 * Mongo + Redis and returns 503 DEGRADED_MODE when a dependency is down.
 */
import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { createApp } from '../app.js'
import type { DbClients } from '@inboxbondhu/core'

function fakeClients(mongoUp: boolean, redisUp: boolean): DbClients {
  return {
    mongoose: {
      connection: {
        db: {
          admin: () => ({
            ping: () => (mongoUp ? Promise.resolve({ ok: 1 }) : Promise.reject(new Error('down'))),
          }),
        },
      },
    },
    redis: {
      ping: () => (redisUp ? Promise.resolve('PONG') : Promise.reject(new Error('down'))),
    },
  } as unknown as DbClients
}

describe('apps/api Phase 0 endpoints', () => {
  it('GET /healthz — 200 with version and uptime, no dependency touched', async () => {
    const app = createApp({ clients: null, version: '0.1.0', startedAt: Date.now() - 5000 })
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ok')
    expect(res.body.data.version).toBe('0.1.0')
    expect(res.body.data.uptimeSeconds).toBeGreaterThanOrEqual(4)
  })

  it('GET /readyz — 200 when Mongo and Redis both ping', async () => {
    const app = createApp({ clients: fakeClients(true, true), version: 'x', startedAt: Date.now() })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ status: 'ready', mongo: true, redis: true })
  })

  it('GET /readyz — 503 DEGRADED_MODE when Mongo is down', async () => {
    const app = createApp({ clients: fakeClients(false, true), version: 'x', startedAt: Date.now() })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('DEGRADED_MODE')
    expect(res.body.error.details).toEqual({ mongo: false, redis: true })
  })

  it('GET /readyz — 503 when Redis is down', async () => {
    const app = createApp({ clients: fakeClients(true, false), version: 'x', startedAt: Date.now() })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.error.details).toEqual({ mongo: true, redis: false })
  })

  it('GET /readyz — 503 before the data layer initialises', async () => {
    const app = createApp({ clients: null, version: 'x', startedAt: Date.now() })
    const res = await request(app).get('/readyz')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('DEGRADED_MODE')
  })
})
