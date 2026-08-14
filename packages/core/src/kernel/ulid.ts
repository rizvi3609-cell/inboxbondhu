/**
 * ULID — sortable IDs for storage keys and correlation (ADR-009: one requestId
 * threads the HTTP log, the trace, the queue job, and the audit row).
 * 26 chars Crockford base32: 10 time + 16 randomness. Monotonic within a ms.
 */
import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford, no I L O U
const TIME_LEN = 10
const RANDOM_LEN = 16

let lastTime = -1
let lastRandom: number[] = []

function encodeTime(time: number): string {
  let out = ''
  let t = time
  for (let i = TIME_LEN - 1; i >= 0; i -= 1) {
    out = ENCODING[t % 32] + out
    t = Math.floor(t / 32)
  }
  return out
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN)
  return Array.from(bytes, (b) => b % 32)
}

/** Generate a ULID. Monotonic: same-millisecond calls increment the random part. */
export function ulid(now: number = Date.now()): string {
  let random: number[]
  if (now === lastTime) {
    // increment lastRandom (base-32 bigint style) for sort stability
    random = [...lastRandom]
    for (let i = RANDOM_LEN - 1; i >= 0; i -= 1) {
      const cur = random[i]!
      if (cur < 31) {
        random[i] = cur + 1
        break
      }
      random[i] = 0
      if (i === 0) random = randomChars() // overflow — vanishingly rare
    }
  } else {
    random = randomChars()
  }
  lastTime = now
  lastRandom = random
  return encodeTime(now) + random.map((v) => ENCODING[v]).join('')
}

export const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value)
}

/** Extract the millisecond timestamp from a ULID. */
export function ulidTime(id: string): number {
  if (!isUlid(id)) throw new TypeError(`ulidTime: not a ULID: ${id}`)
  let t = 0
  for (let i = 0; i < TIME_LEN; i += 1) {
    t = t * 32 + ENCODING.indexOf(id[i]!)
  }
  return t
}
