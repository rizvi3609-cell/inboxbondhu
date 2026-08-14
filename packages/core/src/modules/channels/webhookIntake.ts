/**
 * The ≤500 ms webhook intake — INV-06. The EXACT six-step order (§9 Phase 3):
 *   1. HMAC over the RAW body, constant-time. Invalid → record, still 200.
 *   2. dedupeKey = {provider}:{pageId}:{mid}
 *   3. Redis SET wh:{dedupeKey} NX EX 86400 — not set → duplicate → skip.
 *   4. Insert webhookEvents pending. E11000 on I48 → deduped, NOT an error.
 *   5. Enqueue webhook-ingest.
 *   6. Return 200. Nothing else — no tenant resolution, no parsing, no AI.
 *
 * Mongo down → Redis buffer, 200. Redis ALSO down → D22 disk journal, 200.
 * NEVER a non-2xx to Meta for an internal fault.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Redis } from 'ioredis'
import mongoose from 'mongoose'
import { WebhookEvent } from '../../db/models/index.js'

/**
 * Degraded-mode probe: mongoose readyState !== 1 means Mongo is known-down —
 * skip the insert entirely rather than eating the driver's 5 s
 * serverSelectionTimeout inside the ≤500 ms budget (INV-06).
 */
function mongoAvailable(): boolean {
  return mongoose.connection.readyState === 1
}

const DAY_S = 86_400

export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  const got = header.slice('sha256='.length)
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b) // constant-time
}

/** GET /webhooks/meta — hub.challenge echo, constant-time verify-token compare. */
export function verifyChallengeToken(given: string | undefined, expected: string): boolean {
  if (!given) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface ParsedEntry {
  provider: 'facebook' | 'instagram'
  externalPageId: string
  mid: string
  dedupeKey: string
  entry: Record<string, unknown> // the single messaging envelope, verbatim
}

/** Pull the per-message entries out of a Meta webhook body. Malformed pieces are skipped. */
export function extractEntries(body: unknown): ParsedEntry[] {
  const out: ParsedEntry[] = []
  const root = body as { object?: string; entry?: unknown[] } | null
  if (!root || !Array.isArray(root.entry)) return out
  const provider: 'facebook' | 'instagram' = root.object === 'instagram' ? 'instagram' : 'facebook'
  for (const e of root.entry) {
    const entry = e as { id?: string; messaging?: unknown[] }
    if (!entry.id || !Array.isArray(entry.messaging)) continue
    for (const m of entry.messaging) {
      const msg = m as {
        message?: { mid?: string }
        delivery?: { mids?: string[]; watermark?: number }
        read?: { watermark?: number }
        postback?: { mid?: string }
        timestamp?: number
      }
      // Receipts have no mid — synthesise a stable key from the watermark (DF-01: normal path).
      const mid =
        msg.message?.mid ??
        msg.postback?.mid ??
        (msg.delivery ? `delivery.${entry.id}.${msg.delivery.watermark ?? msg.timestamp ?? 0}` : undefined) ??
        (msg.read ? `read.${entry.id}.${msg.read.watermark ?? msg.timestamp ?? 0}` : undefined)
      if (!mid) continue
      out.push({
        provider,
        externalPageId: entry.id,
        mid,
        dedupeKey: `${provider}:${entry.id}:${mid}`, // plaintext, never hashed
        entry: m as Record<string, unknown>,
      })
    }
  }
  return out
}

export interface IntakeDeps {
  redis: Redis | null
  /** Step 5 — enqueue webhook-ingest. Failures must not break the 200. */
  enqueue: (job: { dedupeKey: string; requestId: string }) => Promise<void>
  journalDir: string
  now?: () => Date
}

export interface IntakeResult {
  accepted: number
  duplicates: number
  buffered: 'none' | 'redis' | 'journal'
  signatureValid: boolean
}

const BUFFER_KEY = 'wh:buffer' // Redis LIST of raw events awaiting Mongo recovery

export async function intakeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
  requestId: string,
  deps: IntakeDeps,
): Promise<IntakeResult> {
  const now = deps.now?.() ?? new Date()

  // Step 1 — signature over the RAW body.
  const signatureValid = verifyMetaSignature(rawBody, signatureHeader, appSecret)

  let body: unknown = null
  try {
    body = JSON.parse(rawBody.toString('utf8'))
  } catch {
    body = null
  }
  const entries = body === null ? [] : extractEntries(body)

  // Invalid signature: record it (best effort) and still 200 — never confirm
  // validity to a prober. No enqueue, no dedupe consumption.
  if (!signatureValid) {
    try {
      if (!mongoAvailable()) throw new Error('degraded') // skip the 5 s driver stall
      await WebhookEvent.create({
        provider: entries[0]?.provider ?? 'facebook',
        externalPageId: entries[0]?.externalPageId ?? 'unknown',
        dedupeKey: `invalid:${requestId}`,
        signatureValid: false,
        rawPayload: body ?? { raw: rawBody.toString('utf8').slice(0, 1000) },
        receivedAt: now,
        processStatus: 'invalid_signature',
        expiresAt: new Date(now.getTime() + 7 * DAY_S * 1000),
      })
    } catch {
      /* recording is best-effort; the 200 is not */
    }
    return { accepted: 0, duplicates: 0, buffered: 'none', signatureValid: false }
  }

  let accepted = 0
  let duplicates = 0
  let buffered: IntakeResult['buffered'] = 'none'

  for (const entry of entries) {
    // Step 3 — Redis fast gate (24 h TTL — deliberately shorter than the 7 d retention).
    if (deps.redis) {
      try {
        const set = await deps.redis.set(`wh:${entry.dedupeKey}`, '1', 'EX', DAY_S, 'NX')
        if (set === null) {
          duplicates += 1
          continue
        }
      } catch {
        /* Redis down — Mongo I48 below is the durable gate */
      }
    }

    // Step 4 — durable record. E11000 = deduped (the >24h redelivery path), not a fault.
    try {
      if (!mongoAvailable()) throw new Error('degraded') // straight to the buffer, no 5 s stall
      await WebhookEvent.create({
        provider: entry.provider,
        externalPageId: entry.externalPageId,
        dedupeKey: entry.dedupeKey,
        signatureValid: true,
        rawPayload: entry.entry,
        receivedAt: now,
        processStatus: 'pending',
        expiresAt: new Date(now.getTime() + 7 * DAY_S * 1000),
      })
      accepted += 1
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        duplicates += 1 // I48 caught it — treat as successful dedupe (gotcha #5)
        continue
      }
      // Mongo down → Redis buffer → journal. Always keep going to the 200.
      const buffableEvent = JSON.stringify({
        dedupeKey: entry.dedupeKey,
        provider: entry.provider,
        externalPageId: entry.externalPageId,
        entry: entry.entry,
        receivedAt: now.toISOString(),
        requestId,
      })
      let stored = false
      if (deps.redis) {
        try {
          await deps.redis.rpush(BUFFER_KEY, buffableEvent)
          buffered = 'redis'
          stored = true
        } catch {
          /* fall through to journal */
        }
      }
      if (!stored) {
        try {
          mkdirSync(deps.journalDir, { recursive: true })
          const file = join(deps.journalDir, `${now.toISOString().slice(0, 10)}.ndjson`)
          appendFileSync(file, buffableEvent + '\n') // D22 append-only ndjson
          buffered = buffered === 'redis' ? 'redis' : 'journal'
          stored = true
        } catch {
          /* last resort exhausted — still 200; the event is in Meta's retry queue */
        }
      }
      if (stored) accepted += 1
      continue
    }

    // Step 5 — enqueue; a queue failure must not break the 200 (the pending
    // row is re-swept by the I49 partial index).
    try {
      await deps.enqueue({ dedupeKey: entry.dedupeKey, requestId })
    } catch {
      /* pending row remains; ingest sweep picks it up */
    }
  }

  return { accepted, duplicates, buffered, signatureValid: true }
}

/**
 * webhookBufferDrainer (every 30 s): replay the Redis buffer (and journal —
 * Phase 8 wires the file half) into webhookEvents once Mongo returns.
 * Dedupe (I48) makes replay safe.
 */
export async function drainRedisBuffer(
  redis: Redis,
  enqueue: (job: { dedupeKey: string; requestId: string }) => Promise<void>,
  max = 1000,
): Promise<{ drained: number; deduped: number }> {
  let drained = 0
  let deduped = 0
  for (let i = 0; i < max; i += 1) {
    const raw = await redis.lpop(BUFFER_KEY)
    if (!raw) break
    const evt = JSON.parse(raw) as {
      dedupeKey: string; provider: 'facebook' | 'instagram'; externalPageId: string
      entry: Record<string, unknown>; receivedAt: string; requestId: string
    }
    try {
      await WebhookEvent.create({
        provider: evt.provider,
        externalPageId: evt.externalPageId,
        dedupeKey: evt.dedupeKey,
        signatureValid: true, // only verified events enter the buffer
        rawPayload: evt.entry,
        receivedAt: new Date(evt.receivedAt),
        processStatus: 'pending',
        expiresAt: new Date(new Date(evt.receivedAt).getTime() + 7 * DAY_S * 1000),
      })
      drained += 1
      await enqueue({ dedupeKey: evt.dedupeKey, requestId: evt.requestId }).catch(() => undefined)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        deduped += 1 // replay-safe by design
        continue
      }
      // Mongo still down — push it back and stop.
      await redis.lpush(BUFFER_KEY, raw)
      break
    }
  }
  return { drained, deduped }
}

/**
 * The journal half of webhookBufferDrainer (P9): replay D22 ndjson files into
 * webhookEvents once Mongo returns. Resumable and idempotent:
 *   - a file is processed line-by-line; on a mid-file Mongo failure the
 *     UNPROCESSED remainder is rewritten to the file and the drain stops;
 *   - fully drained files are deleted;
 *   - I48 (unique dedupeKey) makes every replay safe — E11000 = deduped.
 * The `.draining` rename makes the per-file claim atomic: a concurrent intake
 * append simply recreates a fresh date-file, so no line is ever lost.
 */
export async function drainJournal(
  journalDir: string,
  enqueue: (job: { dedupeKey: string; requestId: string }) => Promise<void>,
  maxLines = 5000,
): Promise<{ drained: number; deduped: number; failed: number }> {
  let drained = 0
  let deduped = 0
  let failed = 0
  if (!mongoAvailable()) return { drained, deduped, failed }

  let files: string[]
  try {
    files = readdirSync(journalDir)
      .filter((f) => f.endsWith('.ndjson') || f.endsWith('.ndjson.draining'))
      .sort() // date-named files → receipt order across days
  } catch {
    return { drained, deduped, failed } // no journal dir — nothing buffered
  }

  let budget = maxLines
  for (const file of files) {
    if (budget <= 0) break
    const path = join(journalDir, file)
    // Claim: rename to .draining so a concurrent appender starts a fresh file.
    let claimed = path
    if (!file.endsWith('.draining')) {
      claimed = `${path}.draining`
      try {
        renameSync(path, claimed)
      } catch {
        continue // another drainer claimed it
      }
    }

    let lines: string[]
    try {
      lines = readFileSync(claimed, 'utf8').split('\n').filter((l) => l.trim())
    } catch {
      continue
    }

    let stoppedAt = -1 // first UNPROCESSED index when we halt early
    let i = 0
    for (; i < lines.length; i += 1) {
      if (budget <= 0) {
        stoppedAt = i // budget exhausted mid-file — keep the tail
        break
      }
      budget -= 1
      let evt: {
        dedupeKey: string; provider: 'facebook' | 'instagram'; externalPageId: string
        entry: Record<string, unknown>; receivedAt: string; requestId: string
      }
      try {
        evt = JSON.parse(lines[i]!) as typeof evt
      } catch {
        failed += 1 // corrupt line — count it, never let it wedge the drain
        continue
      }
      try {
        await WebhookEvent.create({
          provider: evt.provider,
          externalPageId: evt.externalPageId,
          dedupeKey: evt.dedupeKey,
          signatureValid: true, // only verified events reach the journal
          rawPayload: evt.entry,
          receivedAt: new Date(evt.receivedAt),
          processStatus: 'pending',
          expiresAt: new Date(new Date(evt.receivedAt).getTime() + 7 * DAY_S * 1000),
        })
        drained += 1
        await enqueue({ dedupeKey: evt.dedupeKey, requestId: evt.requestId }).catch(() => undefined)
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          deduped += 1 // I48 — replay-safe by design
          continue
        }
        stoppedAt = i // Mongo gone again mid-drain — keep the remainder
        break
      }
    }

    if (stoppedAt >= 0) {
      // Resumable: rewrite ONLY the unprocessed tail, stop draining.
      writeFileSync(claimed, lines.slice(stoppedAt).join('\n') + '\n')
      break
    }
    try {
      unlinkSync(claimed) // fully drained
    } catch {
      /* already gone */
    }
  }
  return { drained, deduped, failed }
}

export { BUFFER_KEY }
