/**
 * Display formatters (C-12 money, C-13 Dhaka time). Pure functions, no deps.
 */

/** ৳ from integer minor units — never a float in business logic (C-12). */
export function taka(minor: number): string {
  return `৳${(minor / 100).toLocaleString('en-IN')}`
}

const DHAKA = 'Asia/Dhaka'

export function dhakaTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: DHAKA, hour: '2-digit', minute: '2-digit' })
}

export function dhakaDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: DHAKA, day: '2-digit', month: 'short' })
}

export function dhakaDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: DHAKA, hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short',
  })
}

/** "2 min ago" style relative time (Dhaka-anchored, coarse on purpose). */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime()
  if (diff < 60_000) return 'now'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} h ago`
  const d = Math.floor(hr / 24)
  if (d < 7) return `${d} d ago`
  return dhakaDate(iso)
}

/** Countdown to a deadline, e.g. the Meta 24h window ("3 h 12 m"). */
export function countdown(iso: string, now = Date.now()): { text: string; expired: boolean; urgent: boolean } {
  const left = new Date(iso).getTime() - now
  if (left <= 0) return { text: 'closed', expired: true, urgent: false }
  const h = Math.floor(left / 3_600_000)
  const m = Math.floor((left % 3_600_000) / 60_000)
  return { text: h > 0 ? `${h} h ${m} m` : `${m} m`, expired: false, urgent: left < 3_600_000 }
}
