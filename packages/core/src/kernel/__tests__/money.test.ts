import { describe, expect, it } from 'vitest'
import { Money } from '../money.js'

describe('Money — INV-02, the most-tested primitive', () => {
  it('of() accepts integers, rejects floats and NaN', () => {
    expect(Money.of(0)).toBe(0)
    expect(Money.of(149900)).toBe(149900)
    expect(() => Money.of(1499.5)).toThrow(/not an integer/)
    expect(() => Money.of(Number.NaN)).toThrow()
    expect(() => Money.of(Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/)
  })

  it('fromTaka handles the two-decimal boundary exactly', () => {
    expect(Money.fromTaka(1499)).toBe(149900)
    expect(Money.fromTaka(1499.99)).toBe(149999)
    expect(Money.fromTaka(0.01)).toBe(1)
    // The classic float trap: 0.1 + 0.2
    expect(Money.fromTaka(0.1 + 0.2)).toBe(30)
    expect(() => Money.fromTaka(0.001)).toThrow(/sub-poisha/)
  })

  it('toTaka is display-only inverse', () => {
    expect(Money.toTaka(149900)).toBe(1499)
    expect(Money.toTaka(1)).toBe(0.01)
    expect(() => Money.toTaka(1.5)).toThrow()
  })

  it('add/sub reject floats on either side', () => {
    expect(Money.add(100, 250)).toBe(350)
    expect(Money.sub(1000, 999)).toBe(1)
    expect(() => Money.add(100.5, 1)).toThrow()
    expect(() => Money.sub(100, 0.5)).toThrow()
  })

  it('mulQty: integer quantity only', () => {
    expect(Money.mulQty(129900, 2)).toBe(259800)
    expect(Money.mulQty(129900, 0)).toBe(0)
    expect(() => Money.mulQty(129900, 1.5)).toThrow(/quantity/)
    expect(() => Money.mulQty(129900, -1)).toThrow(/quantity/)
    expect(() => Money.mulQty(1299.5, 2)).toThrow()
  })

  it('percentOf FLOORS, never rounds — property across the whole discount range', () => {
    // 33% of 259800 = 85734 exactly; 33% of 101 = 33.33 → 33
    expect(Money.percentOf(259800, 33)).toBe(85734)
    expect(Money.percentOf(101, 33)).toBe(33)
    expect(Money.percentOf(99, 50)).toBe(49) // 49.5 → floor
    for (let pct = 0; pct <= 100; pct += 1) {
      for (const base of [0, 1, 99, 101, 33333, 259801, 999999999]) {
        const result = Money.percentOf(base, pct)
        const exact = (base * pct) / 100
        expect(Number.isInteger(result)).toBe(true)
        expect(result).toBeLessThanOrEqual(exact)
        expect(exact - result).toBeLessThan(1)
      }
    }
  })

  it('floorPercent is the documented alias', () => {
    expect(Money.floorPercent(259800, 33)).toBe(Money.percentOf(259800, 33))
  })

  it('percentOf rejects out-of-range and NaN percent', () => {
    expect(() => Money.percentOf(100, -1)).toThrow()
    expect(() => Money.percentOf(100, 101)).toThrow()
    expect(() => Money.percentOf(100, Number.NaN)).toThrow()
  })

  it('the agent.md §6.3 composition works end-to-end without floats', () => {
    const unitPriceMinor = 129900
    const quantity = 3
    const discountPercent = 10
    const deliveryFeeMinor = 6000

    const lineTotal = Money.mulQty(unitPriceMinor, quantity) // 389700
    const discount = Money.floorPercent(lineTotal, discountPercent) // 38970
    const total = Money.add(Money.sub(lineTotal, discount), deliveryFeeMinor)
    expect(total).toBe(389700 - 38970 + 6000)
    expect(Number.isInteger(total)).toBe(true)
  })

  it('format renders BDT for display', () => {
    expect(Money.format(149900)).toBe('৳1,499.00')
    expect(Money.format(1)).toBe('৳0.01')
    expect(Money.format(-6000)).toBe('-৳60.00')
  })
})
