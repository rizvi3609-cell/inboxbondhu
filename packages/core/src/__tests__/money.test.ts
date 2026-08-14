/**
 * Money plugin tests — INV-02: money is an integer in minor units, always.
 * A float write to any *Minor field is rejected at the model layer.
 * Order.recalculate() is idempotent; discount FLOORS, never rounds.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Order, Product } from '../db/index.js'
import { dropData, oid, startDb, stopDb } from './setupDb.js'

beforeAll(async () => {
  await startDb()
})
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

const ws = oid()

function orderInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: ws,
    orderNumber: 1,
    orderYear: 2026,
    orderCode: 'ORD-2026-00001',
    conversationId: oid(),
    customerId: oid(),
    items: [
      {
        productId: oid(),
        variantSku: 'JAMA-R-M',
        nameSnapshot: 'Cotton Jama',
        variantNameSnapshot: 'Red / M',
        unitPriceMinor: 129900, // ৳1299.00
        quantity: 2,
        lineTotalMinor: 259800,
      },
    ],
    subtotalMinor: 259800,
    discountMinor: 0,
    deliveryFeeMinor: 6000,
    totalMinor: 265800,
    deliveryZone: 'Dhaka',
    deliveryAddress: 'House 1, Road 2, Dhanmondi, Dhaka',
    recipientName: 'Karim',
    recipientPhone: '01712345678',
    createdByType: 'ai' as const,
    purgeAfter: new Date(Date.now() + 90 * 86400_000),
    ...overrides,
  }
}

describe('money plugin — integer minor units only', () => {
  it('rejects a float totalMinor', async () => {
    await expect(Order.create(orderInput({ totalMinor: 2658.5 }))).rejects.toThrow(/integer in minor units/)
  })

  it('rejects a float in a nested array path (items[].unitPriceMinor)', async () => {
    const input = orderInput()
    ;(input.items[0] as { unitPriceMinor: number }).unitPriceMinor = 1299.99
    await expect(Order.create(input)).rejects.toThrow(/integer in minor units/)
  })

  it('rejects a float on product money fields including embedded variants', async () => {
    await expect(
      Product.create({
        workspaceId: ws,
        sku: 'SKU-F',
        name: 'Float trap',
        basePriceMinor: 100.5,
        variants: [{ sku: 'V', name: 'One', stock: 1 }],
      }),
    ).rejects.toThrow(/integer in minor units/)
    await expect(
      Product.create({
        workspaceId: ws,
        sku: 'SKU-F2',
        name: 'Float trap 2',
        basePriceMinor: 10050,
        variants: [{ sku: 'V', name: 'One', stock: 1, priceMinor: 99.9 }],
      }),
    ).rejects.toThrow(/integer in minor units/)
  })

  it('accepts integer money end-to-end', async () => {
    const order = await Order.create(orderInput())
    expect(order.totalMinor).toBe(265800)
  })
})

describe('Order.recalculate() — the server calculates all totals (INV-04)', () => {
  it('recomputes line totals, subtotal, floored discount, and total', async () => {
    const order = await Order.create(orderInput())
    order.discountPercent = 33
    ;(order as unknown as { recalculate(): void }).recalculate()
    // 259800 * 33 / 100 = 85734.0 → floor 85734
    expect(order.discountMinor).toBe(85734)
    expect(order.totalMinor).toBe(259800 - 85734 + 6000)
    expect(Number.isInteger(order.totalMinor)).toBe(true)
  })

  it('FLOORS the discount, never rounds (property check across values)', async () => {
    const order = await Order.create(orderInput())
    for (let pct = 0; pct <= 50; pct += 1) {
      for (const subtotal of [1, 99, 101, 33333, 259801]) {
        order.items[0]!.unitPriceMinor = subtotal
        order.items[0]!.quantity = 1
        order.discountPercent = pct
        ;(order as unknown as { recalculate(): void }).recalculate()
        const exact = (subtotal * pct) / 100
        expect(order.discountMinor).toBe(Math.floor(exact))
        expect(order.discountMinor).toBeLessThanOrEqual(exact)
        expect(Number.isInteger(order.discountMinor)).toBe(true)
        expect(Number.isInteger(order.totalMinor)).toBe(true)
      }
    }
  })

  it('is idempotent — calling twice changes nothing', async () => {
    const order = await Order.create(orderInput())
    order.discountPercent = 17
    const r = order as unknown as { recalculate(): void }
    r.recalculate()
    const snapshot = {
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      totalMinor: order.totalMinor,
      line: order.items[0]!.lineTotalMinor,
    }
    r.recalculate()
    expect({
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      totalMinor: order.totalMinor,
      line: order.items[0]!.lineTotalMinor,
    }).toEqual(snapshot)
  })

  it('discountPercent > 50 is rejected by the model (money-loss control, layer 2 of 3)', async () => {
    const order = await Order.create(orderInput())
    order.discountPercent = 51
    await expect(order.save()).rejects.toThrow()
  })
})
