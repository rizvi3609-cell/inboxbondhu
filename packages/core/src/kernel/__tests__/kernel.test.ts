import { describe, expect, it } from 'vitest'
import { Result } from '../result.js'
import { ulid, isUlid, ulidTime } from '../ulid.js'
import { DhakaTime, type BusinessDay } from '../dhakaTime.js'
import { createEventBus } from '../eventBus.js'
import { makeTenantContext } from '../tenantContext.js'
import { AppError, VersionConflictError, CANONICAL_CODES } from '../appError.js'

describe('Result<T,E>', () => {
  it('ok/err discriminate', () => {
    const good = Result.ok(42)
    const bad = Result.err(new AppError('NOT_FOUND', 'missing'))
    expect(good.ok && good.value).toBe(42)
    expect(!bad.ok && bad.error.code).toBe('NOT_FOUND')
  })

  it('map and andThen short-circuit on err', () => {
    const start: Result<number, string> = Result.err('nope')
    expect(Result.map(start, (v) => v + 1)).toEqual({ ok: false, error: 'nope' })
    expect(Result.andThen(start, (v) => Result.ok(v))).toEqual({ ok: false, error: 'nope' })
    expect(Result.map(Result.ok(1), (v) => v + 1)).toEqual({ ok: true, value: 2 })
  })

  it('fromPromise converts rejection to Err', async () => {
    const r = await Result.fromPromise(Promise.reject(new Error('x')), () => 'mapped')
    expect(r).toEqual({ ok: false, error: 'mapped' })
    expect(await Result.fromPromise(Promise.resolve(7), () => 'e')).toEqual({ ok: true, value: 7 })
  })

  it('unwrap throws the error', () => {
    expect(() => Result.unwrap(Result.err(new Error('boom')))).toThrow('boom')
    expect(Result.unwrap(Result.ok('v'))).toBe('v')
  })
})

describe('ulid', () => {
  it('generates 26-char Crockford ULIDs', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(isUlid(id)).toBe(true)
  })

  it('is monotonic within the same millisecond (sortable)', () => {
    const t = Date.now()
    const ids = Array.from({ length: 100 }, () => ulid(t))
    const sorted = [...ids].sort()
    expect(ids).toEqual(sorted)
    expect(new Set(ids).size).toBe(100)
  })

  it('encodes the timestamp recoverably', () => {
    const t = 1735689600000
    expect(ulidTime(ulid(t))).toBe(t)
  })

  it('later time sorts later', () => {
    const a = ulid(1000000000000)
    const b = ulid(1000000000001)
    expect(a < b).toBe(true)
  })
})

describe('DhakaTime — Asia/Dhaka (UTC+6, no DST)', () => {
  it('dhakaYear rolls at 18:00 UTC on Dec 31', () => {
    expect(DhakaTime.dhakaYear(new Date('2026-12-31T17:59:00Z'))).toBe(2026)
    expect(DhakaTime.dhakaYear(new Date('2026-12-31T18:00:00Z'))).toBe(2027)
  })

  it('dhakaPeriodKey gives the Dhaka calendar month', () => {
    expect(DhakaTime.dhakaPeriodKey(new Date('2026-08-14T10:00:00Z'))).toBe('2026-08')
    // 31 Aug 18:30 UTC is already 1 Sep 00:30 in Dhaka
    expect(DhakaTime.dhakaPeriodKey(new Date('2026-08-31T18:30:00Z'))).toBe('2026-09')
  })

  it('startOfDhakaMonth is the UTC instant of 00:00 Dhaka on the 1st', () => {
    const start = DhakaTime.startOfDhakaMonth(new Date('2026-08-14T10:00:00Z'))
    expect(start.toISOString()).toBe('2026-07-31T18:00:00.000Z')
  })

  const days: BusinessDay[] = Array.from({ length: 7 }, (_, day) => ({
    day,
    open: '10:00',
    close: '22:00',
    closed: day === 5, // Friday closed
  }))

  it('isWithinBusinessHours respects open/close in Dhaka local time', () => {
    // Thursday 2026-08-13 11:00 Dhaka = 05:00 UTC
    expect(DhakaTime.isWithinBusinessHours(days, new Date('2026-08-13T05:00:00Z'))).toBe(true)
    // Thursday 23:00 Dhaka = 17:00 UTC → closed
    expect(DhakaTime.isWithinBusinessHours(days, new Date('2026-08-13T17:00:00Z'))).toBe(false)
    // Friday (day 5) 11:00 Dhaka → closed:true
    expect(DhakaTime.isWithinBusinessHours(days, new Date('2026-08-14T05:00:00Z'))).toBe(false)
  })

  it('supports overnight windows (close < open)', () => {
    const night: BusinessDay[] = days.map((d) => ({ ...d, open: '20:00', close: '02:00', closed: false }))
    // 21:00 Dhaka
    expect(DhakaTime.isWithinBusinessHours(night, new Date('2026-08-13T15:00:00Z'))).toBe(true)
    // 01:00 Dhaka (next day window tail)
    expect(DhakaTime.isWithinBusinessHours(night, new Date('2026-08-13T19:00:00Z'))).toBe(true)
    // 12:00 Dhaka
    expect(DhakaTime.isWithinBusinessHours(night, new Date('2026-08-13T06:00:00Z'))).toBe(false)
  })

  it('rejects a days array that is not exactly 7', () => {
    expect(() => DhakaTime.isWithinBusinessHours(days.slice(0, 6))).toThrow(/exactly 7/)
  })
})

describe('eventBus', () => {
  it('delivers events to subscribers and supports unsubscribe', () => {
    const bus = createEventBus()
    const seen: string[] = []
    const off = bus.on('member.removed', (e) => {
      seen.push(e.workspaceId)
    })
    bus.emit({ type: 'member.removed', workspaceId: 'w1', requestId: 'r', payload: {}, occurredAt: new Date() })
    off()
    bus.emit({ type: 'member.removed', workspaceId: 'w2', requestId: 'r', payload: {}, occurredAt: new Date() })
    expect(seen).toEqual(['w1'])
  })

  it('isolates a throwing handler — others still run, error is reported', () => {
    const errors: unknown[] = []
    const bus = createEventBus((e) => errors.push(e))
    const seen: number[] = []
    bus.on('x', () => {
      throw new Error('handler bug')
    })
    bus.on('x', () => {
      seen.push(1)
    })
    bus.emit({ type: 'x', workspaceId: 'w', requestId: 'r', payload: {}, occurredAt: new Date() })
    expect(seen).toEqual([1])
    expect(errors).toHaveLength(1)
  })
})

describe('tenantContext + appError', () => {
  it('TenantContext is frozen', () => {
    const ctx = makeTenantContext({ workspaceId: 'w', userId: 'u', role: 'agent', requestId: 'r' })
    expect(Object.isFrozen(ctx)).toBe(true)
  })

  it('all 18 canonical codes exist; VERSION_CONFLICT extends the envelope', () => {
    expect(CANONICAL_CODES).toHaveLength(18)
    const vc = new VersionConflictError(3, ['status'])
    expect(vc.code).toBe('VERSION_CONFLICT')
    expect(vc.currentVersion).toBe(3)
    expect(vc.conflictingFields).toEqual(['status'])
  })
})
