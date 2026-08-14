import { z } from 'zod'
import { bdPhone, emailAddress, isoDate, objectIdString, ulidString } from './common.js'

// ─── users (D01) — GLOBAL, no workspaceId ────────────────────────────────────

export const userStatus = z.enum(['active', 'deactivated', 'pending_deletion'])

export const UserDoc = z
  .object({
    ulid: ulidString,
    email: emailAddress,
    emailVerifiedAt: isoDate.nullish(),
    /**
     * Argon2id m=19456,t=2,p=1 — `select: false` in Mongoose.
     * Exactly one place may `.select('+passwordHash')`: the login use case (Phase 2).
     */
    passwordHash: z.string().min(1),
    name: z.string().min(2).max(80),
    phone: bdPhone.nullish(),
    locale: z.enum(['bn-en']).default('bn-en'),
    status: userStatus.default('active'),
    deactivatedAt: isoDate.nullish(),
    purgeAfter: isoDate.nullish(),
    /**
     * TRAP (database.md §2.1): cumulative, NEVER reset by a successful login.
     * Resets only on successful OTP unlock or password reset.
     */
    failedLoginCount: z.number().int().min(0).default(0),
    lockedUntil: isoDate.nullish(),
    unlockOtpHash: z.string().nullish(),
    unlockOtpExpiresAt: isoDate.nullish(),
    lastLoginAt: isoDate.nullish(),
  })
  .strict()
export type UserDoc = z.infer<typeof UserDoc>

// ─── sessions (D02) — GLOBAL (user-scoped) ───────────────────────────────────

export const revokedReason = z.enum([
  'logout',
  'reuse_detected',
  'evicted',
  'member_removed',
  'password_changed',
  'rotated',
])

export const SessionDoc = z
  .object({
    userId: objectIdString,
    familyId: ulidString,
    /** SHA-256 of a 32-byte opaque token. Unique, global (I04). */
    refreshTokenHash: z.string().length(64),
    generation: z.number().int().min(0).default(0),
    userAgent: z.string().max(300),
    ipHash: z.string().length(64),
    lastUsedAt: isoDate,
    /** TTL 0 = createdAt + 30d. Space reclamation only; revokedAt is the security control. */
    expiresAt: isoDate,
    revokedAt: isoDate.nullish(),
    revokedReason: revokedReason.nullish(),
  })
  .strict()
export type SessionDoc = z.infer<typeof SessionDoc>
