/**
 * MOD-01 crypto helpers. Argon2id per §3.1 (m=19456, t=2, p=1), zxcvbn ≥ 3,
 * SHA-256 for opaque tokens, HS256 JWTs with sid/gen claims (§8.2).
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import zxcvbn from 'zxcvbn'
import jwt from 'jsonwebtoken'
import { AppError } from '../../kernel/appError.js'

export const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const

/** Small starter blocklist; PRD only demands "common passwords blocked". */
const COMMON_PASSWORDS = new Set([
  'password12345', 'password123456', 'qwerty1234567', 'admin1234567',
  'welcome123456', 'letmein123456', 'iloveyou12345', 'dhaka12345678',
])

export function checkPasswordStrength(password: string, userInputs: string[] = []): void {
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError('VALIDATION_FAILED', 'This password is too common. Choose something unique.', {
      details: [{ path: 'password', issue: 'common password' }],
    })
  }
  const score = zxcvbn(password.slice(0, 72), userInputs).score
  if (score < 3) {
    throw new AppError('VALIDATION_FAILED', 'Password is too weak — add length or unpredictability.', {
      details: [{ path: 'password', issue: `zxcvbn score ${score} < 3` }],
    })
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTS)
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password)
  } catch {
    return false
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hashIp(ip: string, pepper: string): string {
  return sha256Hex(`${ip}${pepper}`)
}

/** 32-byte opaque token (refresh, verification, reset, invitation). */
export function opaqueToken(): string {
  return randomBytes(32).toString('hex') // 64 chars
}

/** 6-digit unlock OTP. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ─── JWT access tokens (§8.2): sub, sid, gen; 15 min; NO role/workspaceId ────

export interface AccessClaims {
  sub: string
  sid: string
  gen: number
}

export function signAccessToken(claims: AccessClaims, secret: string, ttlSeconds: number): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: ttlSeconds })
}

/** Verifies against the current secret, then the previous (rotation overlap). */
export function verifyAccessToken(
  token: string,
  secret: string,
  previousSecret?: string,
): AccessClaims | null {
  for (const s of [secret, previousSecret]) {
    if (!s) continue
    try {
      const payload = jwt.verify(token, s, { algorithms: ['HS256'] }) as jwt.JwtPayload
      if (typeof payload.sub === 'string' && typeof payload['sid'] === 'string' && typeof payload['gen'] === 'number') {
        return { sub: payload.sub, sid: payload['sid'] as string, gen: payload['gen'] as number }
      }
      return null
    } catch {
      // try next secret
    }
  }
  return null
}
