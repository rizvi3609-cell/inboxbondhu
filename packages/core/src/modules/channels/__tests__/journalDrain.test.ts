/**
 * P9 — the journal half of webhookBufferDrainer: D22 ndjson files replay
 * into webhookEvents once Mongo returns. Resumable (unprocessed tail kept),
 * idempotent (I48 dedupe), corrupt lines never wedge the drain.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebhookEvent } from '../../../db/index.js'
import { drainJournal } from '../webhookIntake.js'
import { dropData, startDb, stopDb } from '../../../__tests__/setupDb.js'

const REQ = '0'.repeat(26)

function journalLine(mid: string, pageId = '108888001'): string {
  return JSON.stringify({
    dedupeKey: `facebook:${pageId}:${mid}`,
    provider: 'facebook',
    externalPageId: pageId,
    entry: { message: { mid, text: 'dam koto?' } },
    receivedAt: new Date().toISOString(),
    requestId: REQ,
  })
}

let dir: string

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  dir = mkdtempSync(join(tmpdir(), 'ib-journal-'))
})

describe('drainJournal — the D22 file half of webhookBufferDrainer', () => {
  it('replays every journal line into webhookEvents and deletes the drained file', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => journalLine(`jm-${i}`))
    writeFileSync(join(dir, '2026-08-14.ndjson'), lines.join('\n') + '\n')

    const enqueued: string[] = []
    const result = await drainJournal(dir, async (job) => void enqueued.push(job.dedupeKey))

    expect(result.drained).toBe(5)
    expect(result.deduped).toBe(0)
    expect(enqueued).toHaveLength(5)
    expect(await WebhookEvent.countDocuments({}).exec()).toBe(5)
    expect(readdirSync(dir)).toHaveLength(0) // fully drained file removed
  })

  it('a REPLAY of the same journal is fully deduped by I48 — zero new events', async () => {
    const lines = Array.from({ length: 3 }, (_, i) => journalLine(`rp-${i}`))
    writeFileSync(join(dir, '2026-08-14.ndjson'), lines.join('\n') + '\n')
    await drainJournal(dir, async () => undefined)

    // Same content appears again (e.g. a second node's copy of the journal).
    writeFileSync(join(dir, '2026-08-15.ndjson'), lines.join('\n') + '\n')
    const second = await drainJournal(dir, async () => undefined)

    expect(second.drained).toBe(0)
    expect(second.deduped).toBe(3)
    expect(await WebhookEvent.countDocuments({}).exec()).toBe(3) // exactly once
  })

  it('drains multiple date files in receipt order', async () => {
    writeFileSync(join(dir, '2026-08-13.ndjson'), journalLine('day1') + '\n')
    writeFileSync(join(dir, '2026-08-14.ndjson'), journalLine('day2') + '\n')
    const result = await drainJournal(dir, async () => undefined)
    expect(result.drained).toBe(2)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('a corrupt line is counted and skipped — the drain never wedges', async () => {
    writeFileSync(
      join(dir, '2026-08-14.ndjson'),
      [journalLine('ok-1'), '{not-json!!!', journalLine('ok-2')].join('\n') + '\n',
    )
    const result = await drainJournal(dir, async () => undefined)
    expect(result.drained).toBe(2)
    expect(result.failed).toBe(1)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('budget exhaustion keeps the unprocessed tail for the next pass (resumable)', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => journalLine(`bg-${i}`))
    writeFileSync(join(dir, '2026-08-14.ndjson'), lines.join('\n') + '\n')

    const first = await drainJournal(dir, async () => undefined, 4)
    expect(first.drained).toBe(4)
    const remaining = readdirSync(dir)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/\.draining$/) // claimed, tail kept
    const tail = readFileSync(join(dir, remaining[0]!), 'utf8').split('\n').filter((l) => l.trim())
    expect(tail).toHaveLength(2)

    const second = await drainJournal(dir, async () => undefined)
    expect(second.drained).toBe(2)
    expect(readdirSync(dir)).toHaveLength(0)
    expect(await WebhookEvent.countDocuments({}).exec()).toBe(6) // no loss, no dupes
  })

  it('missing journal dir is a clean no-op', async () => {
    const result = await drainJournal(join(dir, 'does-not-exist'), async () => undefined)
    expect(result).toEqual({ drained: 0, deduped: 0, failed: 0 })
  })

  it('an enqueue failure does not lose the event — the pending row is already durable', async () => {
    writeFileSync(join(dir, '2026-08-14.ndjson'), journalLine('eq-fail') + '\n')
    const result = await drainJournal(dir, async () => {
      throw new Error('queue down')
    })
    expect(result.drained).toBe(1)
    expect(await WebhookEvent.countDocuments({ processStatus: 'pending' }).exec()).toBe(1)
    expect(existsSync(join(dir, '2026-08-14.ndjson'))).toBe(false)
  })
})
