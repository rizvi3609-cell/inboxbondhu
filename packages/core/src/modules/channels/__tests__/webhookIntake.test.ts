/**
 * CP-1 intake tests — agent.md §10 webhook row:
 * - 200 in < 500 ms WITH MONGO STOPPED (Redis buffer / journal fallback)
 * - replay creates exactly one message-event
 * - bad signature recorded and still 200-equivalent (no throw, no enqueue)
 * - >24h redelivery passes the Redis gate, I48 catches it → treated as dedupe
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mongoose from 'mongoose'
import { WebhookEvent } from '../../../db/index.js'
import { extractEntries, intakeWebhook, verifyChallengeToken, verifyMetaSignature } from '../webhookIntake.js'
import { dropData, startDb, stopDb } from '../../../__tests__/setupDb.js'

const APP_SECRET = 'meta-app-secret-for-tests'
const REQ = '0'.repeat(26)

function sign(body: Buffer): string {
  return `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
}

function metaBody(mid: string, pageId = '108888001', text = 'dam koto?'): Buffer {
  return Buffer.from(JSON.stringify({
    object: 'page',
    entry: [{
      id: pageId, time: Date.now(),
      messaging: [{ sender: { id: 'psid-42' }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } }],
    }],
  }))
}

let journalDir: string

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  journalDir = mkdtempSync(join(tmpdir(), 'ib-journal-'))
})

const noRedis = null // Redis-less path: Mongo I48 is the only dedupe gate

describe('signature + challenge', () => {
  it('verifies HMAC over the raw body; rejects tampered bodies and bad headers', () => {
    const body = metaBody('mid.sig1')
    expect(verifyMetaSignature(body, sign(body), APP_SECRET)).toBe(true)
    expect(verifyMetaSignature(Buffer.concat([body, Buffer.from('x')]), sign(body), APP_SECRET)).toBe(false)
    expect(verifyMetaSignature(body, 'sha256=deadbeef', APP_SECRET)).toBe(false)
    expect(verifyMetaSignature(body, undefined, APP_SECRET)).toBe(false)
    expect(verifyMetaSignature(body, 'md5=abc', APP_SECRET)).toBe(false)
  })

  it('hub.challenge token compare works and rejects wrong tokens', () => {
    expect(verifyChallengeToken('tok', 'tok')).toBe(true)
    expect(verifyChallengeToken('wrong', 'tok')).toBe(false)
    expect(verifyChallengeToken(undefined, 'tok')).toBe(false)
  })
})

describe('entry extraction', () => {
  it('computes the plaintext dedupeKey {provider}:{pageId}:{mid}', () => {
    const entries = extractEntries(JSON.parse(metaBody('mid.X', '107812').toString()))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.dedupeKey).toBe('facebook:107812:mid.X') // never hashed
  })

  it('synthesises stable keys for delivery/read receipts (no mid)', () => {
    const body = {
      object: 'page',
      entry: [{ id: 'p1', messaging: [{ delivery: { watermark: 1700000000001 } }, { read: { watermark: 1700000000002 } }] }],
    }
    const entries = extractEntries(body)
    expect(entries.map((e) => e.dedupeKey)).toEqual([
      'facebook:p1:delivery.p1.1700000000001',
      'facebook:p1:read.p1.1700000000002',
    ])
  })

  it('tolerates malformed bodies without throwing', () => {
    expect(extractEntries(null)).toEqual([])
    expect(extractEntries({})).toEqual([])
    expect(extractEntries({ object: 'page', entry: [{}] })).toEqual([])
  })
})

describe('the six-step intake', () => {
  it('valid event → webhookEvents pending + enqueued', async () => {
    const enqueued: string[] = []
    const body = metaBody('mid.ok1')
    const result = await intakeWebhook(body, sign(body), APP_SECRET, REQ, {
      redis: noRedis, journalDir, enqueue: async (j) => void enqueued.push(j.dedupeKey),
    })
    expect(result).toMatchObject({ accepted: 1, duplicates: 0, buffered: 'none', signatureValid: true })
    const row = await WebhookEvent.findOne({ dedupeKey: 'facebook:108888001:mid.ok1' }).exec()
    expect(row!.processStatus).toBe('pending')
    expect(row!.workspaceId).toBeNull() // NO tenant resolution in the intake
    expect(enqueued).toEqual(['facebook:108888001:mid.ok1'])
  })

  it('invalid signature: recorded invalid_signature, zero accepted, NOT enqueued', async () => {
    const enqueued: string[] = []
    const body = metaBody('mid.bad')
    const result = await intakeWebhook(body, 'sha256=forged', APP_SECRET, REQ, {
      redis: noRedis, journalDir, enqueue: async (j) => void enqueued.push(j.dedupeKey),
    })
    expect(result.signatureValid).toBe(false)
    expect(result.accepted).toBe(0)
    expect(enqueued).toEqual([])
    const recorded = await WebhookEvent.findOne({ processStatus: 'invalid_signature' }).exec()
    expect(recorded).not.toBeNull()
  })

  it('REPLAY: the same payload twice creates exactly one event (I48 path — gotcha #5)', async () => {
    const body = metaBody('mid.replay')
    const deps = { redis: noRedis, journalDir, enqueue: async () => undefined }
    const first = await intakeWebhook(body, sign(body), APP_SECRET, REQ, deps)
    const second = await intakeWebhook(body, sign(body), APP_SECRET, REQ, deps)
    expect(first.accepted).toBe(1)
    expect(second).toMatchObject({ accepted: 0, duplicates: 1 }) // duplicate-key = successful dedupe
    expect(await WebhookEvent.countDocuments({ dedupeKey: 'facebook:108888001:mid.replay' }).exec()).toBe(1)
  })

  it('MONGO STOPPED → journal fallback, still accepted (the 200 path)', async () => {
    await mongoose.disconnect() // simulate Mongo down
    try {
      const body = metaBody('mid.down1')
      const result = await intakeWebhook(body, sign(body), APP_SECRET, REQ, {
        redis: noRedis, journalDir, enqueue: async () => undefined,
      })
      expect(result.accepted).toBe(1)
      expect(result.buffered).toBe('journal') // D22 ndjson
      const files = readdirSync(journalDir)
      expect(files).toHaveLength(1)
      const line = readFileSync(join(journalDir, files[0]!), 'utf8').trim()
      expect(JSON.parse(line)).toMatchObject({ dedupeKey: 'facebook:108888001:mid.down1' })
    } finally {
      await startDb() // reconnect for the rest of the suite
    }
  })

  it('MONGO STOPPED: answers well under 500 ms', async () => {
    await mongoose.disconnect()
    try {
      const body = metaBody('mid.speed')
      const t0 = performance.now()
      await intakeWebhook(body, sign(body), APP_SECRET, REQ, {
        redis: noRedis, journalDir, enqueue: async () => undefined,
      })
      const elapsed = performance.now() - t0
      expect(elapsed).toBeLessThan(500) // INV-06 — typically < 50 ms here
    } finally {
      await startDb()
    }
  })

  it('a failing enqueue does not break acceptance (I49 sweep path)', async () => {
    const body = metaBody('mid.badq')
    const result = await intakeWebhook(body, sign(body), APP_SECRET, REQ, {
      redis: noRedis, journalDir,
      enqueue: async () => { throw new Error('queue down') },
    })
    expect(result.accepted).toBe(1)
    const row = await WebhookEvent.findOne({ dedupeKey: 'facebook:108888001:mid.badq' }).exec()
    expect(row!.processStatus).toBe('pending') // recoverable by the pending sweep
  })
})
