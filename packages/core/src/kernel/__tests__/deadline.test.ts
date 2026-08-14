import { describe, expect, it } from 'vitest'
import { Deadline } from '../deadline.js'
import { AppError } from '../appError.js'

describe('Deadline — backbone of INV-09 (15 s AI abort)', () => {
  it('remaining() counts down from the budget', () => {
    const d = Deadline.start(15000, 1000)
    expect(d.remaining(1000)).toBe(15000)
    expect(d.remaining(6000)).toBe(10000)
    expect(d.remaining(16001)).toBe(0)
    d.clear()
  })

  it('assertRemaining passes when the stage fits and throws when it does not', () => {
    const d = Deadline.start(15000, 0)
    expect(() => d.assertRemaining(700, 14000)).not.toThrow() // 1000 left, needs 700
    expect(() => d.assertRemaining(700, 14500)).toThrow(AppError) // 500 left
    try {
      d.assertRemaining(9000, 10000)
    } catch (e) {
      const err = e as AppError
      expect(err.code).toBe('UPSTREAM_FAILED')
      expect(err.details).toMatchObject({ remainingMs: 5000, requiredMs: 9000 })
    }
    d.clear()
  })

  it('child() budget is min(stage, remaining)', () => {
    const d = Deadline.start(15000, 0)
    const c1 = d.child(9000, 0) // LLM stage: full 9 s fits
    expect(c1.remaining(0)).toBe(9000)
    const c2 = d.child(9000, 10000) // only 5 s left → child gets 5 s
    expect(c2.remaining(10000)).toBe(5000)
    expect(() => d.child(9000, 15001)).toThrow(/no budget/)
    c1.clear()
    c2.clear()
    d.clear()
  })

  it('signal aborts when the budget elapses (real timer)', async () => {
    const d = Deadline.start(30)
    expect(d.signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 60))
    expect(d.signal.aborted).toBe(true)
    expect(d.expired).toBe(true)
  })

  it('parent abort propagates to children', async () => {
    const parent = Deadline.start(30)
    const child = parent.child(10000)
    await new Promise((r) => setTimeout(r, 60))
    expect(child.signal.aborted).toBe(true)
  })

  it('clear() on the success path prevents the abort', async () => {
    const d = Deadline.start(30)
    d.clear()
    await new Promise((r) => setTimeout(r, 60))
    expect(d.signal.aborted).toBe(false)
  })

  it('rejects a non-positive budget', () => {
    expect(() => Deadline.start(0)).toThrow()
    expect(() => Deadline.start(-5)).toThrow()
    expect(() => Deadline.start(1.5)).toThrow()
  })
})
