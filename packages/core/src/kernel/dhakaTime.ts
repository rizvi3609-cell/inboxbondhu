/**
 * DhakaTime — all business-day logic in Asia/Dhaka; storage always UTC.
 * Dhaka is UTC+6 with no DST, which keeps this arithmetic exact.
 */
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

export interface BusinessDay {
  day: number // 0..6, Sunday = 0 (JS convention)
  open: string // 'HH:mm'
  close: string // 'HH:mm'
  closed: boolean
}

function toDhakaParts(utc: Date): { year: number; month: number; day: number; weekday: number; minutes: number } {
  const shifted = new Date(utc.getTime() + DHAKA_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

function parseHHmm(v: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v)
  if (!m) throw new TypeError(`DhakaTime: invalid HH:mm value "${v}"`)
  return Number(m[1]) * 60 + Number(m[2])
}

export const DhakaTime = {
  /** Current instant — storage is always UTC. */
  now(): Date {
    return new Date()
  },

  /** Calendar year in Asia/Dhaka (order-counter scope). */
  dhakaYear(at: Date = new Date()): number {
    return toDhakaParts(at).year
  },

  /** `YYYY-MM` billing period key in the Asia/Dhaka calendar. */
  dhakaPeriodKey(at: Date = new Date()): string {
    const { year, month } = toDhakaParts(at)
    return `${year}-${String(month).padStart(2, '0')}`
  },

  /** UTC instant of 00:00 on the 1st of the current Dhaka month. */
  startOfDhakaMonth(at: Date = new Date()): Date {
    const { year, month } = toDhakaParts(at)
    return new Date(Date.UTC(year, month - 1, 1) - DHAKA_OFFSET_MS)
  },

  /** UTC instant of 00:00 Dhaka today. */
  startOfDhakaDay(at: Date = new Date()): Date {
    const { year, month, day } = toDhakaParts(at)
    return new Date(Date.UTC(year, month - 1, day) - DHAKA_OFFSET_MS)
  },

  /**
   * Business-hours check against workspaces.businessHours.days (7 entries).
   * `closed: true` or a missing day entry ⇒ outside hours.
   * Overnight windows (close < open, e.g. 20:00–02:00) span midnight.
   */
  isWithinBusinessHours(days: readonly BusinessDay[], at: Date = new Date()): boolean {
    if (days.length !== 7) throw new TypeError('DhakaTime: businessHours.days must have exactly 7 entries')
    const { weekday, minutes } = toDhakaParts(at)
    const today = days.find((d) => d.day === weekday)
    if (!today || today.closed) return false
    const open = parseHHmm(today.open)
    const close = parseHHmm(today.close)
    if (open === close) return false // zero-length window
    if (open < close) return minutes >= open && minutes < close
    // overnight window
    return minutes >= open || minutes < close
  },
} as const
