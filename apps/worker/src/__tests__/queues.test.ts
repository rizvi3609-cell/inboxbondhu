/**
 * Queue registry tests — the §13.1 table is the spec; drift here is a bug.
 */
import { describe, expect, it } from 'vitest'
import { QUEUE_SPECS, emailBackoffMs } from '../queues.js'

describe('§13.1 queue table', () => {
  it('registers exactly the nine queues', () => {
    expect(QUEUE_SPECS.map((q) => q.name)).toEqual([
      'webhook-ingest',
      'conversation-ai',
      'outbound-message',
      'media-fetch',
      'email',
      'csv-import',
      'payment-events',
      'notification',
      'dead-letter',
    ])
  })

  it('conversation-ai concurrency is deliberately 3 (LLM spend bound)', () => {
    expect(QUEUE_SPECS.find((q) => q.name === 'conversation-ai')?.concurrency).toBe(3)
  })

  it('csv-import concurrency is 1 so checkpointing stays coherent', () => {
    expect(QUEUE_SPECS.find((q) => q.name === 'csv-import')?.concurrency).toBe(1)
  })

  it('attempts match the table', () => {
    const byName = Object.fromEntries(QUEUE_SPECS.map((q) => [q.name, q.attempts]))
    expect(byName).toMatchObject({
      'webhook-ingest': 5,
      'conversation-ai': 2,
      'outbound-message': 4,
      'media-fetch': 3,
      email: 3,
      'csv-import': 3,
      'payment-events': 5,
      notification: 3,
    })
  })

  it('email ladder is 30 s / 2 m / 10 m', () => {
    expect(emailBackoffMs(0)).toBe(30_000)
    expect(emailBackoffMs(1)).toBe(120_000)
    expect(emailBackoffMs(2)).toBe(600_000)
    expect(emailBackoffMs(9)).toBe(600_000) // clamps
  })
})
