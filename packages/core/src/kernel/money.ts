/**
 * Money — INV-02: always an integer in minor units (poisha). Field names end
 * in `Minor`. No floats, ever. A branded type prevents accidental raw
 * arithmetic (ADR-006).
 */
declare const MoneyBrand: unique symbol
export type MoneyMinor = number & { readonly [MoneyBrand]: true }

function assertIntegerMinor(value: number, op: string): asserts value is MoneyMinor {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Money.${op}: ${value} is not an integer in minor units (INV-02)`)
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money.${op}: ${value} exceeds the safe integer range`)
  }
}

export const Money = {
  /** Brand a raw integer as money. Throws on floats. */
  of(minor: number): MoneyMinor {
    assertIntegerMinor(minor, 'of')
    return minor
  },

  /** ৳1499.00 → 149900. Accepts up to 2 decimal places; rejects beyond. */
  fromTaka(taka: number): MoneyMinor {
    const minor = Math.round(taka * 100)
    if (Math.abs(taka * 100 - minor) > 1e-6) {
      throw new TypeError(`Money.fromTaka: ${taka} has sub-poisha precision`)
    }
    assertIntegerMinor(minor, 'fromTaka')
    return minor
  },

  /** 149900 → 1499.00 — display only. Never feed the result back into arithmetic. */
  toTaka(minor: number): number {
    assertIntegerMinor(minor, 'toTaka')
    return minor / 100
  },

  add(a: number, b: number): MoneyMinor {
    assertIntegerMinor(a, 'add')
    assertIntegerMinor(b, 'add')
    const sum = a + b
    assertIntegerMinor(sum, 'add')
    return sum
  },

  sub(a: number, b: number): MoneyMinor {
    assertIntegerMinor(a, 'sub')
    assertIntegerMinor(b, 'sub')
    const diff = a - b
    assertIntegerMinor(diff, 'sub')
    return diff
  },

  /** Line total: unit price × integer quantity. */
  mulQty(unitPriceMinor: number, quantity: number): MoneyMinor {
    assertIntegerMinor(unitPriceMinor, 'mulQty')
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new TypeError(`Money.mulQty: quantity ${quantity} must be a non-negative integer`)
    }
    const total = unitPriceMinor * quantity
    assertIntegerMinor(total, 'mulQty')
    return total
  },

  /**
   * percentOf — FLOORS, never rounds (agent.md §6.3). The discount can only
   * ever favour the seller by at most one poisha.
   */
  percentOf(baseMinor: number, percent: number): MoneyMinor {
    assertIntegerMinor(baseMinor, 'percentOf')
    if (typeof percent !== 'number' || Number.isNaN(percent) || percent < 0 || percent > 100) {
      throw new RangeError(`Money.percentOf: percent ${percent} out of range 0–100`)
    }
    const result = Math.floor((baseMinor * percent) / 100)
    assertIntegerMinor(result, 'percentOf')
    return result
  },

  /** Alias used in the agent.md §6.3 exemplar. */
  floorPercent(baseMinor: number, percent: number): MoneyMinor {
    return Money.percentOf(baseMinor, percent)
  },

  /** BDT display: 149900 → "৳1,499.00". */
  format(minor: number): string {
    assertIntegerMinor(minor, 'format')
    const sign = minor < 0 ? '-' : ''
    const abs = Math.abs(minor)
    const taka = Math.floor(abs / 100)
    const poisha = String(abs % 100).padStart(2, '0')
    return `${sign}৳${taka.toLocaleString('en-US')}.${poisha}`
  },
} as const
