/**
 * MOD-01 tests — agent.md §10 required cases:
 * - Lockout: 5/10/15 ladder; failedLoginCount SURVIVES a successful login
 * - Sessions: max 5 with LRU eviction by lastUsedAt; refresh reuse kills the family
 * - T4 registration bootstrap atomicity
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Membership, OutboxEvent, Session, User, Workspace } from '../../../db/index.js'
import { IdentityService } from '../service.js'
import { verifyAccessToken } from '../crypto.js'
import { dropData, sha256ish, startDb, stopDb } from '../../../__tests__/setupDb.js'

const cfg = { jwtSecret: 'x'.repeat(32), accessTtlSeconds: 900, refreshTtlDays: 30, maxSessions: 5 }
const device = { userAgent: 'vitest', ipHash: sha256ish('ip') }
const STRONG = 'Krishnochura#Dhanmondi27'

let svc: IdentityService

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
  svc = new IdentityService(cfg)
})

async function registerAndVerify(email = 'seller@rupa.example'): Promise<string> {
  const r = await svc.register({
    email, password: STRONG, name: 'Rupa Owner', storeName: 'Rupa Fashion', requestId: '0'.repeat(26),
  })
  expect(r.ok).toBe(true)
  if (!r.ok) throw r.error
  await User.updateOne({ _id: r.value.userId }, { $set: { emailVerifiedAt: new Date() } }).exec()
  return r.value.userId
}

describe('T4 registration', () => {
  it('creates user + workspace + owner membership + verification outbox atomically', async () => {
    const r = await svc.register({
      email: 'new@x.example', password: STRONG, name: 'New Seller', storeName: 'Notun Dokan', requestId: '0'.repeat(26),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const user = await User.findOne({ email: 'new@x.example' }).exec()
    expect(user).not.toBeNull()
    expect(user!.emailVerifiedAt).toBeNull() // no session until verified
    const ws = await Workspace.findOne({ slug: 'notun-dokan' }).exec()
    expect(ws).not.toBeNull()
    const member = await Membership.findOne({ workspaceId: ws!._id, userId: user!._id, removedAt: null }).exec()
    expect(member!.role).toBe('owner')
    const outbox = await OutboxEvent.findOne({ type: 'email.verification' })
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'outboxDispatcher' }).exec()
    expect(outbox).not.toBeNull()
    // Raw token NEVER stored — only its hash in the payload.
    expect(JSON.stringify(outbox!.payload)).not.toContain(r.value.verificationToken)
  })

  it('rejects a weak password (zxcvbn < 3) and a duplicate email', async () => {
    const weak = await svc.register({
      email: 'w@x.example', password: 'Password123', name: 'Weak Pass', storeName: 'Shop', requestId: '0'.repeat(26),
    })
    expect(weak.ok).toBe(false)
    if (!weak.ok) expect(weak.error.code).toBe('VALIDATION_FAILED')

    await registerAndVerify('dup@x.example')
    const dup = await svc.register({
      email: 'dup@x.example', password: STRONG, name: 'Dup', storeName: 'Shop 2', requestId: '0'.repeat(26),
    })
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.error.code).toBe('DUPLICATE_RESOURCE')
  })

  it('slug collision gets an incremented suffix (PRD §2.1)', async () => {
    await registerAndVerify('a@x.example')
    const r2 = await svc.register({
      email: 'b@x.example', password: STRONG, name: 'B Seller', storeName: 'Rupa Fashion', requestId: '0'.repeat(26),
    })
    expect(r2.ok).toBe(true)
    const slugs = (await Workspace.find({ name: 'Rupa Fashion' }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }).exec()).map((w) => w.slug).sort()
    expect(slugs).toEqual(['rupa-fashion', 'rupa-fashion-2'])
  })

  it('unverified login is rejected with a distinct message; verification unblocks it', async () => {
    const r = await svc.register({
      email: 'v@x.example', password: STRONG, name: 'Verify Me', storeName: 'V Shop', requestId: '0'.repeat(26),
    })
    if (!r.ok) throw r.error
    const blocked = await svc.login({ email: 'v@x.example', password: STRONG, device })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.error.message).toMatch(/not verified/i)

    const verified = await svc.verifyEmail(r.value.verificationToken)
    expect(verified.ok).toBe(true)
    const login = await svc.login({ email: 'v@x.example', password: STRONG, device })
    expect(login.ok).toBe(true)
  })
})

describe('lockout ladder (§8.4) — the most misimplemented rule', () => {
  it('5 failures → 1 min lock; 10 → 15 min; 15 → indefinite', async () => {
    await registerAndVerify()
    const fail = () => svc.login({ email: 'seller@rupa.example', password: 'Wrong-pass-1X', device })

    for (let i = 0; i < 4; i += 1) expect((await fail()).ok).toBe(false)
    let user = await User.findOne({ email: 'seller@rupa.example' }).exec()
    expect(user!.failedLoginCount).toBe(4)
    expect(user!.lockedUntil).toBeNull()

    await fail() // 5th
    user = await User.findOne({ email: 'seller@rupa.example' }).exec()
    expect(user!.failedLoginCount).toBe(5)
    expect(user!.lockedUntil!.getTime()).toBeGreaterThan(Date.now())
    expect(user!.lockedUntil!.getTime()).toBeLessThan(Date.now() + 2 * 60_000)

    // Clear the temp lock to keep failing (simulates waiting out the minute).
    await User.updateOne({ email: 'seller@rupa.example' }, { $set: { lockedUntil: null } }).exec()
    for (let i = 0; i < 5; i += 1) {
      await fail()
      await User.updateOne({ email: 'seller@rupa.example' }, { $set: { lockedUntil: null } }).exec()
    }
    user = await User.findOne({ email: 'seller@rupa.example' }).exec()
    expect(user!.failedLoginCount).toBe(10)

    for (let i = 0; i < 5; i += 1) {
      await User.updateOne({ email: 'seller@rupa.example' }, { $set: { lockedUntil: null } }).exec()
      await fail()
    }
    user = await User.findOne({ email: 'seller@rupa.example' }).exec()
    expect(user!.failedLoginCount).toBe(15)
    expect(user!.lockedUntil!.getFullYear()).toBeGreaterThan(2090) // indefinite

    const locked = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    expect(locked.ok).toBe(false)
    if (!locked.ok) expect(locked.error.code).toBe('ACCOUNT_LOCKED')
  })

  it('failedLoginCount SURVIVES a successful login (cumulative by design)', async () => {
    await registerAndVerify()
    for (let i = 0; i < 3; i += 1) {
      await svc.login({ email: 'seller@rupa.example', password: 'Wrong-pass-1X', device })
    }
    const success = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    expect(success.ok).toBe(true)
    const user = await User.findOne({ email: 'seller@rupa.example' }).exec()
    expect(user!.failedLoginCount).toBe(3) // NOT reset — agent.md gotcha #1
  })

  it('OTP unlock clears lockedUntil AND resets the counter; reset-password does too', async () => {
    const userId = await registerAndVerify()
    await User.updateOne({ _id: userId }, { $set: { failedLoginCount: 15, lockedUntil: new Date('2100-01-01') } }).exec()

    const req = await svc.requestUnlockOtp('seller@rupa.example')
    expect(req.ok).toBe(true)
    if (!req.ok || !req.value.otp) throw new Error('no otp')
    const bad = await svc.verifyUnlockOtp('seller@rupa.example', req.value.otp === '000000' ? '000001' : '000000')
    expect(bad.ok).toBe(false)
    const good = await svc.verifyUnlockOtp('seller@rupa.example', req.value.otp)
    expect(good.ok).toBe(true)

    const user = await User.findOne({ _id: userId }).exec()
    expect(user!.failedLoginCount).toBe(0)
    expect(user!.lockedUntil).toBeNull()
    expect(user!.unlockOtpHash).toBeNull()
  })
})

describe('sessions — max 5 with LRU eviction by lastUsedAt (I05)', () => {
  it('6th login evicts the LEAST-RECENTLY-USED, not the oldest-created', async () => {
    await registerAndVerify()
    const sessions: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const r = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
      if (!r.ok) throw r.error
      sessions.push(r.value.sessionId)
    }
    // Make the OLDEST-CREATED session the most recently USED.
    await Session.updateOne({ _id: sessions[0] }, { $set: { lastUsedAt: new Date(Date.now() + 60_000) } }).exec()
    // Second-created is now the LRU.
    const sixth = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    if (!sixth.ok) throw sixth.error
    expect(sixth.value.evictedSessionId).toBe(sessions[1]) // NOT sessions[0]

    const evicted = await Session.findOne({ _id: sessions[1] }).exec()
    expect(evicted!.revokedReason).toBe('evicted')
    const survivor = await Session.findOne({ _id: sessions[0] }).exec()
    expect(survivor!.revokedAt).toBeNull()

    const active = await Session.countDocuments({ revokedAt: null }).exec()
    expect(active).toBe(5) // never 6
  })

  it('issues JWT with sub/sid/gen and NO role or workspaceId (§8.2)', async () => {
    const userId = await registerAndVerify()
    const r = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    if (!r.ok) throw r.error
    const claims = verifyAccessToken(r.value.accessToken, cfg.jwtSecret)
    expect(claims).toMatchObject({ sub: userId, sid: r.value.sessionId, gen: 0 })
    const decoded = JSON.parse(Buffer.from(r.value.accessToken.split('.')[1]!, 'base64url').toString())
    expect(decoded.role).toBeUndefined()
    expect(decoded.workspaceId).toBeUndefined()
  })
})

describe('refresh rotation + family revocation (§8.3)', () => {
  it('rotation inserts a new row (gen+1, same family) and marks the old one rotated', async () => {
    await registerAndVerify()
    const login = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    if (!login.ok) throw login.error

    const refreshed = await svc.refresh(login.value.refreshToken, device)
    expect(refreshed.ok).toBe(true)
    if (!refreshed.ok) return

    const oldRow = await Session.findOne({ _id: login.value.sessionId }).exec()
    expect(oldRow!.revokedReason).toBe('rotated')
    const newRow = await Session.findOne({ _id: refreshed.value.sessionId }).exec()
    expect(newRow!.generation).toBe(1)
    expect(newRow!.familyId).toBe(oldRow!.familyId)
    expect(String(newRow!._id)).not.toBe(String(oldRow!._id)) // insert, not update-in-place
  })

  it('REUSING a rotated token revokes the ENTIRE family → 401 SESSION_REVOKED', async () => {
    await registerAndVerify()
    const login = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    if (!login.ok) throw login.error
    const r1 = await svc.refresh(login.value.refreshToken, device)
    if (!r1.ok) throw r1.error
    const r2 = await svc.refresh(r1.value.refreshToken, device)
    if (!r2.ok) throw r2.error

    // Replay the FIRST (rotated-out) token — attacker scenario.
    const reuse = await svc.refresh(login.value.refreshToken, device)
    expect(reuse.ok).toBe(false)
    if (!reuse.ok) expect(reuse.error.code).toBe('SESSION_REVOKED')

    // The whole family is dead, including the newest legitimate session.
    const family = await Session.find({ familyId: (await Session.findOne({ _id: login.value.sessionId }).exec())!.familyId }).exec()
    expect(family.length).toBeGreaterThanOrEqual(3)
    expect(family.every((s) => s.revokedAt !== null)).toBe(true)
    const newest = family.find((s) => String(s._id) === r2.value.sessionId)
    expect(newest!.revokedReason).toBe('reuse_detected')
  })

  it('logout-all revokes every session for the user', async () => {
    const userId = await registerAndVerify()
    await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    const out = await svc.logoutAll(userId)
    expect(out.ok && out.value.revoked).toBe(2)
    expect(await Session.countDocuments({ userId, revokedAt: null }).exec()).toBe(0)
  })
})

describe('password reset', () => {
  it('valid token swaps the hash, revokes ALL sessions, resets the counter', async () => {
    const userId = await registerAndVerify()
    await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    await User.updateOne({ _id: userId }, { $set: { failedLoginCount: 7 } }).exec()

    const forgot = await svc.forgotPassword('seller@rupa.example')
    if (!forgot.ok || !forgot.value.resetToken) throw new Error('no token')
    const NEW = 'Lalbagh#Kella1678Fort'
    const reset = await svc.resetPassword(forgot.value.resetToken, NEW)
    expect(reset.ok).toBe(true)

    expect(await Session.countDocuments({ userId, revokedAt: null }).exec()).toBe(0)
    const user = await User.findOne({ _id: userId }).exec()
    expect(user!.failedLoginCount).toBe(0)

    expect((await svc.login({ email: 'seller@rupa.example', password: STRONG, device })).ok).toBe(false)
    expect((await svc.login({ email: 'seller@rupa.example', password: NEW, device })).ok).toBe(true)

    // Single-use: replaying the same token fails.
    const replay = await svc.resetPassword(forgot.value.resetToken, 'Another#Strong9Password')
    expect(replay.ok).toBe(false)
  })

  it('forgotPassword answers identically for unknown emails (no enumeration)', async () => {
    const r = await svc.forgotPassword('ghost@nowhere.example')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.resetToken).toBeNull()
  })
})

describe('deactivation (PRD §2.1)', () => {
  it('requires password re-auth; sets status/deactivatedAt/purgeAfter(+90d); kills sessions', async () => {
    const userId = await registerAndVerify()
    await svc.login({ email: 'seller@rupa.example', password: STRONG, device })

    const wrong = await svc.deactivate(userId, 'Wrong-pass-1X')
    expect(wrong.ok).toBe(false)

    const ok = await svc.deactivate(userId, STRONG)
    expect(ok.ok).toBe(true)
    const user = await User.findOne({ _id: userId }).exec()
    expect(user!.status).toBe('deactivated')
    const days = (user!.purgeAfter!.getTime() - user!.deactivatedAt!.getTime()) / 86_400_000
    expect(Math.round(days)).toBe(90)
    expect(await Session.countDocuments({ userId, revokedAt: null }).exec()).toBe(0)

    const login = await svc.login({ email: 'seller@rupa.example', password: STRONG, device })
    expect(login.ok).toBe(false)
  })
})
