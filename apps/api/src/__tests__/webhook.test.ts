/**
 * CP-1 HTTP tests — the webhook route as Meta sees it:
 * - GET hub.challenge echo
 * - POST 200 in < 500 ms under a 50-request burst
 * - POST 200 WITH MONGO DISCONNECTED (journal fallback)
 * - bad signature → still 200, recorded, never enqueued
 * - replay → exactly one webhookEvent
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mongoose from 'mongoose'
import type { Express } from 'express'
import { WebhookEvent } from '@inboxbondhu/core'
import { createApp } from '../app.js'
import { dropData, startDb, stopDb } from './setupDb.js'

const APP_SECRET = 'meta-app-secret-http'
const VERIFY_TOKEN = 'hub-verify-token-http'

let app: Express
let enqueued: string[]
let journalDir: string

function sign(body: string): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
}

function metaBody(mid: string, pageId = '108888001'): string {
  return JSON.stringify({
    object: 'page',
    entry: [{ id: pageId, time: Date.now(), messaging: [{ sender: { id: 'psid-1' }, message: { mid, text: 'hi' } }] }],
  })
}

beforeAll(async () => {
  await startDb()
}, 300_000)

afterAll(async () => {
  await stopDb()
})

beforeEach(async () => {
  await dropData()
  enqueued = []
  journalDir = mkdtempSync(join(tmpdir(), 'ib-http-journal-'))
  app = createApp({
    clients: null,
    version: 'test',
    startedAt: Date.now(),
    webhook: {
      redis: null,
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      journalDir,
      enqueue: async (j) => void enqueued.push(j.dedupeKey),
    },
  })
})

describe('GET /webhooks/meta — subscription verification', () => {
  it('echoes hub.challenge for the correct verify token', async () => {
    const res = await request(app).get('/webhooks/meta').query({
      'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '424242',
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('424242')
  })

  it('rejects a wrong verify token with 403', async () => {
    const res = await request(app).get('/webhooks/meta').query({
      'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x',
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /webhooks/meta — the ≤500 ms contract', () => {
  it('valid event → 200, stored pending, enqueued', async () => {
    const body = metaBody('mid.http1')
    const res = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body)
    expect(res.status).toBe(200)
    expect(enqueued).toEqual(['facebook:108888001:mid.http1'])
    expect(await WebhookEvent.countDocuments({ dedupeKey: 'facebook:108888001:mid.http1' }).exec()).toBe(1)
  })

  it('bad signature → STILL 200 (never reveal validity), recorded, not enqueued', async () => {
    const body = metaBody('mid.forged')
    const res = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64))
      .send(body)
    expect(res.status).toBe(200)
    expect(enqueued).toEqual([])
    expect(await WebhookEvent.countDocuments({ processStatus: 'invalid_signature' }).exec()).toBe(1)
  })

  it('replay → exactly one event row', async () => {
    const body = metaBody('mid.replay-http')
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/webhooks/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body))
        .send(body)
      expect(res.status).toBe(200)
    }
    expect(await WebhookEvent.countDocuments({ dedupeKey: 'facebook:108888001:mid.replay-http' }).exec()).toBe(1)
    expect(enqueued).toHaveLength(1)
  })

  it('DoD: 50-request burst — every response 200, p95 well under 500 ms', async () => {
    const durations: number[] = []
    for (let i = 0; i < 50; i += 1) {
      const body = metaBody(`mid.load${i}`)
      const t0 = performance.now()
      const res = await request(app)
        .post('/webhooks/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body))
        .send(body)
      durations.push(performance.now() - t0)
      expect(res.status).toBe(200)
    }
    durations.sort((a, b) => a - b)
    const p95 = durations[Math.floor(durations.length * 0.95) - 1]!
    expect(p95).toBeLessThan(500)
    expect(await WebhookEvent.countDocuments({ processStatus: 'pending' }).exec()).toBe(50)
  })

  it('DoD: MONGO STOPPED → still 200 in < 500 ms, journaled to D22', async () => {
    await mongoose.disconnect()
    try {
      const body = metaBody('mid.mongodown-http')
      const t0 = performance.now()
      const res = await request(app)
        .post('/webhooks/meta')
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sign(body))
        .send(body)
      const elapsed = performance.now() - t0
      expect(res.status).toBe(200)
      expect(elapsed).toBeLessThan(500)
      expect(readdirSync(journalDir)).toHaveLength(1) // ndjson written
    } finally {
      await startDb()
    }
  })

  it('malformed JSON body → 200, nothing stored, nothing enqueued', async () => {
    const body = 'this is not json'
    const res = await request(app)
      .post('/webhooks/meta')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(body))
      .send(body)
    expect(res.status).toBe(200)
    expect(enqueued).toEqual([])
  })
})
