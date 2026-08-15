/**
 * FE-F1 — C-8 / architecture.md §12.8 VERBATIM:
 *   delay = min(30s, 500ms * 2^n) * random()
 * The formula is a spec quote; this test pins it so a refactor can't drift it.
 */
import { describe, expect, it } from 'vitest'
import { backoffDelay } from '../socket.js'

describe('socket reconnect backoff (§12.8)', () => {
  it('matches min(30s, 500ms·2^n)·random() exactly at rand=1', () => {
    const one = () => 1
    expect(backoffDelay(0, one)).toBe(500)      // 500·2^0
    expect(backoffDelay(1, one)).toBe(1_000)    // 500·2^1
    expect(backoffDelay(4, one)).toBe(8_000)    // 500·2^4
    expect(backoffDelay(5, one)).toBe(16_000)
    expect(backoffDelay(6, one)).toBe(30_000)   // 32s capped at 30s
    expect(backoffDelay(19, one)).toBe(30_000)  // stays capped through attempt 20
  })

  it('applies FULL jitter — the random factor scales the whole delay', () => {
    expect(backoffDelay(6, () => 0.5)).toBe(15_000)
    expect(backoffDelay(6, () => 0)).toBe(0) // full jitter includes 0 by definition
    expect(backoffDelay(2, () => 0.25)).toBe(500)
  })

  it('never exceeds the 30 s cap for any attempt/random pair', () => {
    for (let n = 0; n <= 25; n += 1) {
      for (const r of [0, 0.25, 0.5, 0.99, 1]) {
        expect(backoffDelay(n, () => r)).toBeLessThanOrEqual(30_000)
      }
    }
  })
})
