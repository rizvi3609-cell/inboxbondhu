/**
 * Phase 9 load test — 2× the CON-05 capacity target against a LIVE api.
 *
 * Target load (architecture.md §14.1): 50 ws × 500 conv/day ≈ 3 000 webhook
 * msgs/day, ~2 rps at the 8–11 PM peak. 2× target ⇒ ~4 rps sustained peak.
 * This driver pushes WELL past that (concurrent bursts) and asserts the two
 * §16.2 performance gates that apply to the HTTP surface:
 *   - webhook POST p95 < 500 ms (INV-06)
 *   - /healthz p95 < 200 ms (cheap-probe sanity)
 *
 * Usage:  tsx tools/loadTest.ts [baseUrl] [appSecret] [seconds]
 *   defaults: http://127.0.0.1:4000  dev-meta-app-secret  20
 *
 * Exit code 0 = all gates passed; 1 = a gate failed (CI-friendly).
 */
import { createHmac } from 'node:crypto'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:4000'
const appSecret = process.argv[3] ?? 'dev-meta-app-secret'
const seconds = Number(process.argv[4] ?? 20)

// 2× the modelled peak of ~2 rps, plus bursts: 8 rps steady with 16-wide
// concurrent spikes every 5 s (reconnect-storm shaped).
const STEADY_RPS = 8
const BURST_WIDTH = 16

function metaBody(mid: string): string {
  return JSON.stringify({
    object: 'page',
    entry: [{
      id: '108888001',
      time: Date.now(),
      messaging: [{ sender: { id: 'psid-load' }, recipient: { id: '108888001' }, timestamp: Date.now(), message: { mid, text: 'dam koto bhaiya?' } }],
    }],
  })
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`
}

async function timedPost(path: string, body: string, headers: Record<string, string>): Promise<{ ms: number; status: number }> {
  const t0 = performance.now()
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body })
  await res.arrayBuffer()
  return { ms: performance.now() - t0, status: res.status }
}

async function timedGet(path: string): Promise<{ ms: number; status: number }> {
  const t0 = performance.now()
  const res = await fetch(`${baseUrl}${path}`)
  await res.arrayBuffer()
  return { ms: performance.now() - t0, status: res.status }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

async function main(): Promise<void> {
  console.log(`load test → ${baseUrl} for ${seconds}s (steady ${STEADY_RPS} rps + ${BURST_WIDTH}-wide bursts)`)

  const webhookMs: number[] = []
  const healthMs: number[] = []
  let non200 = 0
  let seq = 0
  const runId = Date.now().toString(36)

  const deadline = Date.now() + seconds * 1000
  let lastBurst = 0

  while (Date.now() < deadline) {
    const wave: Array<Promise<void>> = []
    const isBurst = Date.now() - lastBurst > 5000
    if (isBurst) lastBurst = Date.now()
    const width = isBurst ? BURST_WIDTH : STEADY_RPS

    for (let i = 0; i < width; i += 1) {
      const body = metaBody(`mid.load-${runId}-${seq}`)
      seq += 1
      wave.push(
        timedPost('/webhooks/meta', body, {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': sign(body),
        }).then((r) => {
          webhookMs.push(r.ms)
          if (r.status !== 200) non200 += 1
        }),
      )
    }
    wave.push(timedGet('/healthz').then((r) => void healthMs.push(r.ms)))
    await Promise.all(wave)
    await new Promise((r) => setTimeout(r, 1000))
  }

  webhookMs.sort((a, b) => a - b)
  healthMs.sort((a, b) => a - b)

  const report = {
    webhook: {
      count: webhookMs.length,
      non200,
      p50: Math.round(percentile(webhookMs, 0.5)),
      p95: Math.round(percentile(webhookMs, 0.95)),
      p99: Math.round(percentile(webhookMs, 0.99)),
      max: Math.round(webhookMs.at(-1) ?? 0),
    },
    healthz: {
      count: healthMs.length,
      p95: Math.round(percentile(healthMs, 0.95)),
    },
  }
  console.log(JSON.stringify(report, null, 2))

  const failures: string[] = []
  if (report.webhook.non200 > 0) failures.push(`${report.webhook.non200} non-200 webhook responses (must be 0 — Meta disables the subscription)`)
  if (report.webhook.p95 >= 500) failures.push(`webhook p95 ${report.webhook.p95}ms ≥ 500ms (INV-06)`)
  if (report.healthz.p95 >= 200) failures.push(`/healthz p95 ${report.healthz.p95}ms ≥ 200ms`)

  if (failures.length > 0) {
    console.error('LOAD TEST FAILED:\n- ' + failures.join('\n- '))
    process.exit(1)
  }
  console.log('LOAD TEST PASSED — all gates green at 2× target load.')
}

void main().catch((err: Error) => {
  console.error(`load test could not run: ${err.message}`)
  process.exit(1)
})
