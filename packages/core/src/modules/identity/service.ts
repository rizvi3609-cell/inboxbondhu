/**
 * MOD-01 identity service — register (T4), verify, login (cumulative lockout
 * ladder §8.4, max-5 LRU eviction), refresh rotation + family revocation
 * (§8.3), logout(-all), forgot/reset, OTP unlock, me, deactivate.
 *
 * All business logic lives HERE; routes stay thin (agent.md §5.2).
 */
import type { ClientSession } from 'mongoose'
import mongoose from 'mongoose'
import { AppError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import { ulid } from '../../kernel/ulid.js'
import { withTx } from '../../db/withTx.js'
import { Membership, OutboxEvent, Session, User, Workspace } from '../../db/models/index.js'
import {
  checkPasswordStrength, generateOtp, hashPassword, opaqueToken,
  sha256Hex, signAccessToken, verifyPassword,
} from './crypto.js'

const DAY_MS = 86_400_000

export interface IdentityConfig {
  jwtSecret: string
  accessTtlSeconds: number // 15 min
  refreshTtlDays: number // 30
  maxSessions: number // 5
}

export interface DeviceInfo {
  userAgent: string
  ipHash: string
}

export interface IssuedSession {
  accessToken: string
  refreshToken: string // opaque, cookie value — NEVER stored, only its hash
  sessionId: string
  csrfToken: string
}

interface UserDocLike {
  _id: mongoose.Types.ObjectId
  email: string
  name: string
  status: string
  emailVerifiedAt: Date | null
  failedLoginCount: number
  lockedUntil: Date | null
  unlockOtpHash: string | null
  unlockOtpExpiresAt: Date | null
  version?: number
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 34)
  return base.length >= 3 ? base : `store-${base}`.slice(0, 34)
}

export class IdentityService {
  constructor(private readonly cfg: IdentityConfig) {}

  // ── Registration — Transaction T4 ─────────────────────────────────────────

  /**
   * T4: users + workspaces + memberships(owner) + outbox email.verification.
   * Response 201 with NO session — login is blocked until verified.
   */
  async register(input: {
    email: string
    password: string
    name: string
    storeName: string
    phone?: string
    requestId: string
  }): Promise<Result<{ userId: string; workspaceId: string; verificationToken: string }, AppError>> {
    try {
      checkPasswordStrength(input.password, [input.email, input.name, input.storeName])
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
    const passwordHash = await hashPassword(input.password)
    const verificationToken = opaqueToken()

    try {
      const out = await withTx(async (session) => {
        const existing = await User.findOne({ email: input.email }).session(session).exec()
        if (existing) throw new AppError('DUPLICATE_RESOURCE', 'An account with this email already exists.')

        const [user] = await User.create(
          [{
            ulid: ulid(),
            email: input.email,
            passwordHash,
            name: input.name,
            phone: input.phone ?? null,
            // Verification token stored hashed in unlockOtpHash? No — separate concern:
            // we reuse the outbox payload for the email; the hash lives on the user row.
            unlockOtpHash: null,
          }],
          { session },
        )

        const slug = await this.uniqueSlug(slugify(input.storeName), session)
        const [workspace] = await Workspace.create(
          [{
            name: input.storeName,
            slug,
            ownerId: user!._id,
            trialEndsAt: new Date(Date.now() + 14 * DAY_MS),
            businessHours: {
              enabled: false,
              days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })),
            },
            aiConfig: {},
          }],
          { session },
        )

        await Membership.create(
          [{ workspaceId: workspace!._id, userId: user!._id, role: 'owner', joinedAt: new Date() }],
          { session },
        )

        // The verification token is delivered via the outbox (email.verification);
        // the stored payload carries only its SHA-256 — verifyEmail matches on hash.
        await OutboxEvent.create(
          [{
            workspaceId: workspace!._id,
            type: 'email.verification',
            payload: {
              userId: String(user!._id),
              email: input.email,
              tokenHash: sha256Hex(verificationToken),
              expiresAt: new Date(Date.now() + DAY_MS).toISOString(), // 24 h expiry (PRD §2.1)
            },
            idempotencyKey: `email.verification:${String(user!._id)}`,
            nextAttemptAt: new Date(),
          }],
          { session },
        )

        return { userId: String(user!._id), workspaceId: String(workspace!._id) }
      })
      return Result.ok({ ...out, verificationToken })
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      if ((err as { code?: number }).code === 11000) {
        return Result.err(new AppError('DUPLICATE_RESOURCE', 'An account with this email already exists.'))
      }
      throw err
    }
  }

  private async uniqueSlug(base: string, session: ClientSession): Promise<string> {
    let candidate = base
    for (let i = 2; i < 100; i += 1) {
      const hit = await Workspace.findOne({ slug: candidate }).session(session).exec()
      if (!hit) return candidate
      candidate = `${base.slice(0, 30)}-${i}` // suffix incremented on collision (PRD §2.1)
    }
    return `${base.slice(0, 20)}-${ulid().slice(-6).toLowerCase()}`
  }

  // ── Email verification ────────────────────────────────────────────────────

  async verifyEmail(rawToken: string): Promise<Result<{ userId: string }, AppError>> {
    const tokenHash = sha256Hex(rawToken)
    const event = await OutboxEvent.findOne({ 'payload.tokenHash': tokenHash, type: 'email.verification' })
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
      .exec()
    const payload = event?.payload as { userId?: string; expiresAt?: string } | undefined
    if (!event || !payload?.userId) {
      return Result.err(new AppError('NOT_FOUND', 'Verification link is invalid or has expired.'))
    }
    if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
      return Result.err(new AppError('NOT_FOUND', 'Verification link is invalid or has expired.'))
    }
    await User.updateOne(
      { _id: payload.userId, emailVerifiedAt: null },
      { $set: { emailVerifiedAt: new Date() } },
    ).exec()
    return Result.ok({ userId: payload.userId })
  }

  // ── Login — §8.4 ladder + max-5 LRU eviction ─────────────────────────────

  async login(input: {
    email: string
    password: string
    device: DeviceInfo
  }): Promise<Result<IssuedSession & { evictedSessionId: string | null; userId: string }, AppError>> {
    // The ONE permitted .select('+passwordHash') call site (gotcha #2).
    const user = (await User.findOne({ email: input.email })
      .select('+passwordHash')
      .exec()) as (UserDocLike & { passwordHash: string }) | null

    if (!user || user.status !== 'active') {
      return Result.err(new AppError('UNAUTHENTICATED', 'Invalid email or password.'))
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return Result.err(new AppError('ACCOUNT_LOCKED', 'Account locked. Try later or unlock via email OTP.'))
    }
    // 15+ failures and lockedUntil set far-future ⇒ indefinite until OTP (§8.4).

    const passwordOk = await verifyPassword(user.passwordHash, input.password)
    if (!passwordOk) {
      const failed = user.failedLoginCount + 1
      const update: Record<string, unknown> = { $inc: { failedLoginCount: 1 } }
      if (failed >= 15) {
        ;(update['$set'] as Record<string, unknown> | undefined) ??= {}
        ;(update['$set'] as Record<string, unknown>)['lockedUntil'] = new Date('2100-01-01') // indefinite
      } else if (failed >= 10 && failed % 5 === 0) {
        update['$set'] = { lockedUntil: new Date(Date.now() + 15 * 60_000) }
      } else if (failed >= 5 && failed % 5 === 0) {
        update['$set'] = { lockedUntil: new Date(Date.now() + 60_000) }
      }
      await User.updateOne({ _id: user._id }, update).exec()
      if (failed >= 15) {
        return Result.err(new AppError('ACCOUNT_LOCKED', 'Account locked. Unlock via email OTP.'))
      }
      return Result.err(new AppError('UNAUTHENTICATED', 'Invalid email or password.'))
    }

    if (!user.emailVerifiedAt) {
      // Distinct message per §9 Phase 2 item 3.
      return Result.err(new AppError('UNAUTHENTICATED', 'Email not verified. Check your inbox for the verification link.'))
    }

    // DO NOT reset failedLoginCount (the most misimplemented rule).
    const issued = await this.createSession(String(user._id), input.device, null)
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).exec()

    return Result.ok({ ...issued, userId: String(user._id) })
  }

  /**
   * Session creation with atomic max-5 LRU eviction: if the user already has
   * >= maxSessions active sessions, revoke the LEAST-RECENTLY-USED (lowest
   * lastUsedAt — NOT oldest-created) via a single findOneAndUpdate so two
   * simultaneous logins cannot both evict the same row and leave 6 active.
   */
  private async createSession(
    userId: string,
    device: DeviceInfo,
    familyId: string | null,
    generation = 0,
  ): Promise<IssuedSession & { evictedSessionId: string | null }> {
    let evictedSessionId: string | null = null

    const activeCount = await Session.countDocuments({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    }).exec()

    if (activeCount >= this.cfg.maxSessions) {
      const evicted = await Session.findOneAndUpdate(
        { userId, revokedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { revokedAt: new Date(), revokedReason: 'evicted' } },
        { sort: { lastUsedAt: 1 }, new: true }, // lowest lastUsedAt = LRU (I05)
      ).exec()
      if (evicted) evictedSessionId = String(evicted._id)
    }

    const refreshToken = opaqueToken()
    const now = new Date()
    const session = await Session.create({
      userId,
      familyId: familyId ?? ulid(),
      refreshTokenHash: sha256Hex(refreshToken),
      generation,
      userAgent: device.userAgent.slice(0, 300),
      ipHash: device.ipHash,
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + this.cfg.refreshTtlDays * DAY_MS),
    })

    const accessToken = signAccessToken(
      { sub: userId, sid: String(session._id), gen: generation },
      this.cfg.jwtSecret,
      this.cfg.accessTtlSeconds,
    )
    return {
      accessToken,
      refreshToken,
      sessionId: String(session._id),
      csrfToken: opaqueToken(),
      evictedSessionId,
    }
  }

  // ── Refresh — §8.3 rotation + family revocation on reuse ────────────────

  async refresh(
    rawRefreshToken: string,
    device: DeviceInfo,
  ): Promise<Result<IssuedSession & { userId: string }, AppError>> {
    const tokenHash = sha256Hex(rawRefreshToken)
    const session = await Session.findOne({ refreshTokenHash: tokenHash }).exec()
    if (!session) return Result.err(new AppError('UNAUTHENTICATED', 'Invalid refresh token.'))

    if (session.revokedAt) {
      if (session.revokedReason === 'rotated') {
        // TOKEN REUSE — revoke the whole family (§8.3 step 3).
        await Session.updateMany(
          { familyId: session.familyId, revokedAt: null },
          { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
        ).exec()
        return Result.err(new AppError('SESSION_REVOKED', 'Session revoked due to token reuse.', {
          familyRevoked: true,
          userId: String(session.userId),
        }))
      }
      return Result.err(new AppError('SESSION_REVOKED', 'Session has been revoked.'))
    }
    if (session.expiresAt < new Date()) {
      return Result.err(new AppError('UNAUTHENTICATED', 'Refresh token expired.'))
    }

    // Rotation INSERTS a new row (same family, gen+1) and marks the old one
    // 'rotated' — never in place; the old hash must stay queryable (D02 note).
    const issued = await this.createSession(
      String(session.userId),
      device,
      session.familyId,
      session.generation + 1,
    )
    await Session.updateOne(
      { _id: session._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'rotated' } },
    ).exec()

    return Result.ok({ ...issued, userId: String(session.userId) })
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  async logout(sessionId: string, userId: string): Promise<Result<void, AppError>> {
    await Session.updateOne(
      { _id: sessionId, userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    ).exec()
    return Result.ok(undefined)
  }

  async logoutAll(userId: string): Promise<Result<{ revoked: number }, AppError>> {
    const res = await Session.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
    ).exec()
    return Result.ok({ revoked: res.modifiedCount })
  }

  // ── Forgot / reset password ───────────────────────────────────────────────

  /** Generic success regardless of account existence (enumeration defence). */
  async forgotPassword(email: string): Promise<Result<{ resetToken: string | null }, AppError>> {
    const user = await User.findOne({ email }).exec()
    if (!user || user.status !== 'active') return Result.ok({ resetToken: null })

    const resetToken = opaqueToken()
    await OutboxEvent.findOneAndUpdate(
      { idempotencyKey: `email.password_reset:${String(user._id)}:${sha256Hex(resetToken).slice(0, 8)}` },
      {
        $setOnInsert: {
          workspaceId: new mongoose.Types.ObjectId(), // no tenant — identity-level email
          type: 'email.password_reset',
          payload: {
            userId: String(user._id),
            email,
            tokenHash: sha256Hex(resetToken),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(), // 1 h (PRD §2.1)
          },
          nextAttemptAt: new Date(),
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    )
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
      .exec()
    return Result.ok({ resetToken })
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<Result<void, AppError>> {
    const tokenHash = sha256Hex(rawToken)
    const event = await OutboxEvent.findOne({ type: 'email.password_reset', 'payload.tokenHash': tokenHash })
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
      .exec()
    const payload = event?.payload as { userId?: string; expiresAt?: string; usedAt?: string } | undefined
    if (!event || !payload?.userId || payload.usedAt || (payload.expiresAt && new Date(payload.expiresAt) < new Date())) {
      return Result.err(new AppError('NOT_FOUND', 'Reset link is invalid or has expired.'))
    }

    try {
      checkPasswordStrength(newPassword)
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
    const passwordHash = await hashPassword(newPassword)

    // Single-use: mark consumed first (best-effort), then swap the hash.
    await OutboxEvent.updateOne(
      { _id: event._id },
      { $set: { 'payload.usedAt': new Date().toISOString() } },
    )
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' })
      .exec()

    await User.updateOne(
      { _id: payload.userId },
      {
        $set: {
          passwordHash,
          failedLoginCount: 0, // password reset DOES clear the counter (§8.4)
          lockedUntil: null,
          unlockOtpHash: null,
          unlockOtpExpiresAt: null,
        },
      },
    ).exec()

    // Revoke all sessions globally (PRD §2.1 password reset).
    await Session.updateMany(
      { userId: payload.userId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } },
    ).exec()

    return Result.ok(undefined)
  }

  // ── OTP unlock (§8.4) ────────────────────────────────────────────────────

  async requestUnlockOtp(email: string): Promise<Result<{ otp: string | null }, AppError>> {
    const user = await User.findOne({ email }).exec()
    if (!user) return Result.ok({ otp: null }) // no enumeration
    const otp = generateOtp()
    await User.updateOne(
      { _id: user._id },
      { $set: { unlockOtpHash: sha256Hex(otp), unlockOtpExpiresAt: new Date(Date.now() + 10 * 60_000) } },
    ).exec()
    return Result.ok({ otp }) // handed to the email outbox by the route layer
  }

  async verifyUnlockOtp(email: string, otp: string): Promise<Result<void, AppError>> {
    const user = await User.findOne({ email }).exec()
    if (
      !user ||
      !user.unlockOtpHash ||
      !user.unlockOtpExpiresAt ||
      user.unlockOtpExpiresAt < new Date() ||
      user.unlockOtpHash !== sha256Hex(otp)
    ) {
      return Result.err(new AppError('UNAUTHENTICATED', 'Invalid or expired OTP.'))
    }
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          lockedUntil: null,
          failedLoginCount: 0, // OTP unlock clears the cumulative counter (§8.4)
          unlockOtpHash: null,
          unlockOtpExpiresAt: null,
        },
      },
    ).exec()
    return Result.ok(undefined)
  }

  // ── Me / deactivate ──────────────────────────────────────────────────────

  async deactivate(userId: string, password: string): Promise<Result<void, AppError>> {
    const user = await User.findOne({ _id: userId }).select('+passwordHash').exec()
    if (!user) return Result.err(new AppError('NOT_FOUND', 'Account not found.'))
    if (!(await verifyPassword(user.passwordHash as unknown as string, password))) {
      return Result.err(new AppError('UNAUTHENTICATED', 'Password is incorrect.'))
    }
    const now = new Date()
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          status: 'deactivated',
          deactivatedAt: now,
          purgeAfter: new Date(now.getTime() + 90 * DAY_MS), // 90 d retention (PRD §2.1)
        },
      },
    ).exec()
    await Session.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: now, revokedReason: 'logout' } },
    ).exec()
    return Result.ok(undefined)
  }
}
