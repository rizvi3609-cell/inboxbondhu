/**
 * MOD-02 workspace service — workspaces, members (T2 cascade), invitations,
 * ownership transfer (T3). Every method takes TenantContext where scoped;
 * membership-cache invalidation hooks fire synchronously on role change and
 * removal (a stale role cache is privilege escalation).
 */
import mongoose from 'mongoose'
import { AppError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { ulid } from '../../kernel/ulid.js'
import { withTx } from '../../db/withTx.js'
import {
  AuditLog, Conversation, Invitation, Membership, OutboxEvent, Session, User, Workspace,
} from '../../db/models/index.js'
import { MAX_PENDING_INVITATIONS_DEFAULT } from '@inboxbondhu/contracts'
import { opaqueToken, sha256Hex, verifyPassword } from '../identity/crypto.js'
import { findUserWithPasswordHash } from '../identity/repository.js'

const DAY_MS = 86_400_000
export type MembershipCacheInvalidator = (workspaceId: string, userId: string) => Promise<void>

export class WorkspaceService {
  constructor(
    /** Synchronous cache invalidation — wired to Redis in apps/api. */
    private readonly invalidateMembershipCache: MembershipCacheInvalidator = async () => undefined,
    private readonly maxPendingInvites: number = MAX_PENDING_INVITATIONS_DEFAULT,
  ) {}

  // ── Workspaces ────────────────────────────────────────────────────────────

  async create(userId: string, name: string): Promise<Result<{ workspaceId: string; slug: string }, AppError>> {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34)
    const slugBase = base.length >= 3 ? base : `store-${base}`.slice(0, 34)
    try {
      const out = await withTx(async (session) => {
        let slug = slugBase
        for (let i = 2; ; i += 1) {
          if (!(await Workspace.findOne({ slug }).session(session).exec())) break
          if (i >= 100) {
            slug = `${slugBase.slice(0, 20)}-${ulid().slice(-6).toLowerCase()}`
            break
          }
          slug = `${slugBase.slice(0, 30)}-${i}`
        }
        const [ws] = await Workspace.create(
          [{
            name,
            slug,
            ownerId: userId,
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
          [{ workspaceId: ws!._id, userId, role: 'owner', joinedAt: new Date() }],
          { session },
        )
        return { workspaceId: String(ws!._id), slug }
      })
      return Result.ok(out)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return Result.err(new AppError('DUPLICATE_RESOURCE', 'A workspace with this name already exists.'))
      }
      throw err
    }
  }

  async listForUser(userId: string): Promise<Result<Array<{ workspaceId: string; name: string; slug: string; role: string }>, AppError>> {
    const memberships = await Membership.find({ userId, removedAt: null })
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }) // user-scoped switcher (I13)
      .exec()
    const ids = memberships.map((m) => m.workspaceId)
    const workspaces = await Workspace.find({ _id: { $in: ids } }).exec()
    const byId = new Map(workspaces.map((w) => [String(w._id), w]))
    return Result.ok(
      memberships
        .map((m) => {
          const w = byId.get(String(m.workspaceId))
          return w ? { workspaceId: String(w._id), name: w.name, slug: w.slug, role: m.role } : null
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    )
  }

  // ── Members — T2: the atomic 5-step removal cascade ──────────────────────

  /**
   * T2 (§9 Phase 2 item 10): (a) tombstone membership; (b) unassign their
   * conversations; (c) revoke their sessions; (d) outbox member.removed;
   * (e) audit with actorRole. Then invalidate the membership cache
   * SYNCHRONOUSLY, before returning.
   */
  async removeMember(ctx: TenantContext, targetUserId: string): Promise<Result<void, AppError>> {
    if (targetUserId === ctx.userId) {
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', 'You cannot remove yourself.'))
    }
    try {
      await withTx(async (session) => {
        const target = await Membership.findOne({
          workspaceId: ctx.workspaceId, userId: targetUserId, removedAt: null,
        }).session(session).exec()
        if (!target) throw new AppError('NOT_FOUND', 'Member not found.')
        if (target.role === 'owner') {
          throw new AppError('INSUFFICIENT_PERMISSIONS', 'The owner cannot be removed. Transfer ownership first.')
        }
        // Admins cannot remove other admins unless the actor is the owner (§8.7 "not owner" nuance).
        if (target.role === 'admin' && ctx.role !== 'owner') {
          throw new AppError('INSUFFICIENT_PERMISSIONS', 'Only the owner can remove an admin.')
        }

        // (a) tombstone — never hard-delete
        await Membership.updateOne(
          { _id: target._id, workspaceId: ctx.workspaceId },
          { $set: { removedAt: new Date() } },
          { session },
        ).exec()

        // (b) unassign conversations → pending
        await Conversation.updateMany(
          { workspaceId: ctx.workspaceId, assignedTo: targetUserId },
          { $set: { assignedTo: null, status: 'pending' } },
          { session },
        ).exec()

        // (c) revoke ALL their sessions with member_removed.
        // OPEN QUESTION: §9 says "for that workspace", but sessions are
        // user-scoped with no workspaceId (D02) — narrower reading impossible;
        // revoking all matches the MVP gate ("removing a member revokes their
        // session token") and PRD §2.1 step 3. Flagged.
        await Session.updateMany(
          { userId: targetUserId, revokedAt: null },
          { $set: { revokedAt: new Date(), revokedReason: 'member_removed' } },
          { session },
        ).exec()

        // (d) outbox — email + socket session.revoked
        await OutboxEvent.create(
          [{
            workspaceId: ctx.workspaceId,
            type: 'member.removed',
            payload: { workspaceId: ctx.workspaceId, userId: targetUserId, removedBy: ctx.userId },
            idempotencyKey: `member.removed:${ctx.workspaceId}:${targetUserId}:${Date.now()}`,
            nextAttemptAt: new Date(),
          }],
          { session },
        )

        // (e) audit with the role held AT THE TIME
        await AuditLog.create(
          [{
            workspaceId: ctx.workspaceId,
            actorId: ctx.userId,
            actorType: 'user',
            actorRole: ctx.role === 'system' ? null : ctx.role,
            action: 'member.removed',
            resourceType: 'membership',
            resourceId: String(target._id),
            before: { role: target.role },
            after: { removedAt: new Date().toISOString() },
            requestId: ctx.requestId,
          }],
          { session },
        )
      })
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
    // Synchronous cache invalidation — NOT fire-and-forget.
    await this.invalidateMembershipCache(ctx.workspaceId, targetUserId)
    return Result.ok(undefined)
  }

  async changeRole(
    ctx: TenantContext,
    targetUserId: string,
    newRole: 'admin' | 'agent' | 'viewer',
  ): Promise<Result<void, AppError>> {
    const target = await Membership.findOne({
      workspaceId: ctx.workspaceId, userId: targetUserId, removedAt: null,
    }).exec()
    if (!target) return Result.err(new AppError('NOT_FOUND', 'Member not found.'))
    if (target.role === 'owner') {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Owner role changes only via ownership transfer.'))
    }
    if (target.role === 'admin' && ctx.role !== 'owner') {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Only the owner can change an admin’s role.'))
    }
    const before = target.role
    await Membership.updateOne(
      { _id: target._id, workspaceId: ctx.workspaceId },
      { $set: { role: newRole } },
    ).exec()
    await AuditLog.create({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action: 'member.role_changed',
      resourceType: 'membership',
      resourceId: String(target._id),
      before: { role: before },
      after: { role: newRole },
      requestId: ctx.requestId,
    })
    await this.invalidateMembershipCache(ctx.workspaceId, targetUserId) // synchronous
    return Result.ok(undefined)
  }

  // ── Invitations (§9 Phase 2 item 11) ─────────────────────────────────────

  async invite(
    ctx: TenantContext,
    email: string,
    role: 'admin' | 'agent' | 'viewer',
  ): Promise<Result<{ invitationId: string; token: string }, AppError>> {
    // Already an active member?
    const existingUser = await User.findOne({ email }).exec()
    if (existingUser) {
      const member = await Membership.findOne({
        workspaceId: ctx.workspaceId, userId: existingUser._id, removedAt: null,
      }).exec()
      if (member) return Result.err(new AppError('DUPLICATE_RESOURCE', 'This person is already a member.'))
    }
    const dupePending = await Invitation.findOne({
      workspaceId: ctx.workspaceId, email, status: 'pending',
    }).exec()
    if (dupePending) return Result.err(new AppError('DUPLICATE_RESOURCE', 'An invitation for this email is already pending.'))

    // Max 20 pending — countDocuments guard (may briefly overshoot; accepted).
    const pending = await Invitation.countDocuments({ workspaceId: ctx.workspaceId, status: 'pending' }).exec()
    if (pending >= this.maxPendingInvites) {
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', `Maximum ${this.maxPendingInvites} pending invitations.`))
    }

    const token = opaqueToken()
    const inv = await Invitation.create({
      workspaceId: ctx.workspaceId,
      email,
      role, // schema forbids 'owner'
      tokenHash: sha256Hex(token),
      invitedBy: ctx.userId,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
    })
    await OutboxEvent.create({
      workspaceId: ctx.workspaceId,
      type: 'email.invitation',
      payload: { email, role, tokenHash: sha256Hex(token) },
      idempotencyKey: `email.invitation:${String(inv._id)}`,
      nextAttemptAt: new Date(),
    })
    return Result.ok({ invitationId: String(inv._id), token })
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string): Promise<Result<void, AppError>> {
    const res = await Invitation.updateOne(
      { _id: invitationId, workspaceId: ctx.workspaceId, status: 'pending' },
      { $set: { status: 'revoked' } },
    ).exec()
    if (res.matchedCount === 0) return Result.err(new AppError('NOT_FOUND', 'Invitation not found.'))
    return Result.ok(undefined)
  }

  /** Accept requires a VERIFIED email (§7.2 #23; PRD §3.7 verification block). */
  async acceptInvitation(userId: string, rawToken: string): Promise<Result<{ workspaceId: string; role: string }, AppError>> {
    const user = await User.findOne({ _id: userId }).exec()
    if (!user) return Result.err(new AppError('NOT_FOUND', 'Account not found.'))
    if (!user.emailVerifiedAt) {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Verify your email before accepting an invitation.'))
    }
    const inv = await Invitation.findOne({ tokenHash: sha256Hex(rawToken), status: 'pending' })
      .setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }) // token → tenant resolution (I15)
      .exec()
    if (!inv || inv.expiresAt < new Date()) {
      return Result.err(new AppError('NOT_FOUND', 'Invitation is invalid or has expired.'))
    }
    if (inv.email !== user.email) {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'This invitation was issued to a different email.'))
    }
    const already = await Membership.findOne({
      workspaceId: inv.workspaceId, userId, removedAt: null,
    }).exec()
    if (already) return Result.err(new AppError('DUPLICATE_RESOURCE', 'You are already a member of this workspace.'))

    await Membership.create({
      workspaceId: inv.workspaceId,
      userId,
      role: inv.role,
      invitedBy: inv.invitedBy,
      joinedAt: new Date(),
    })
    await Invitation.updateOne(
      { _id: inv._id, workspaceId: inv.workspaceId },
      { $set: { status: 'accepted', acceptedAt: new Date(), acceptedUserId: userId } },
    ).exec()
    return Result.ok({ workspaceId: String(inv.workspaceId), role: inv.role })
  }

  // ── T3 — ownership transfer ───────────────────────────────────────────────

  /**
   * T3: owner password re-auth; target must be an existing ACTIVE member;
   * demote old owner → admin, promote target → owner, update ownerId; audit
   * both sides. Exactly one owner at every instant (inside one transaction).
   */
  async transferOwnership(
    ctx: TenantContext,
    password: string,
    targetUserId: string,
  ): Promise<Result<void, AppError>> {
    if (ctx.role !== 'owner') {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Only the owner can transfer ownership.'))
    }
    const me = await findUserWithPasswordHash({ _id: ctx.userId })
    if (!me || !(await verifyPassword(me.passwordHash, password))) {
      return Result.err(new AppError('UNAUTHENTICATED', 'Password is incorrect.'))
    }
    if (targetUserId === ctx.userId) {
      return Result.err(new AppError('BUSINESS_RULE_VIOLATION', 'You already own this workspace.'))
    }
    try {
      await withTx(async (session) => {
        const targetUser = await User.findOne({ _id: targetUserId }).session(session).exec()
        if (!targetUser || targetUser.status !== 'active') {
          throw new AppError('NOT_FOUND', 'Target member not found.')
        }
        const targetMember = await Membership.findOne({
          workspaceId: ctx.workspaceId, userId: targetUserId, removedAt: null,
        }).session(session).exec()
        if (!targetMember) throw new AppError('NOT_FOUND', 'Target member not found.')

        const myMember = await Membership.findOne({
          workspaceId: ctx.workspaceId, userId: ctx.userId, role: 'owner', removedAt: null,
        }).session(session).exec()
        if (!myMember) throw new AppError('INSUFFICIENT_PERMISSIONS', 'Only the owner can transfer ownership.')

        // Atomic swap — exactly one owner at every instant within the tx.
        await Membership.updateOne(
          { _id: myMember._id, workspaceId: ctx.workspaceId },
          { $set: { role: 'admin' } },
          { session },
        ).exec()
        await Membership.updateOne(
          { _id: targetMember._id, workspaceId: ctx.workspaceId },
          { $set: { role: 'owner' } },
          { session },
        ).exec()
        await Workspace.updateOne(
          { _id: ctx.workspaceId },
          { $set: { ownerId: new mongoose.Types.ObjectId(targetUserId) } },
          { session },
        ).exec()

        await AuditLog.create(
          [
            {
              workspaceId: ctx.workspaceId,
              actorId: ctx.userId,
              actorType: 'user',
              actorRole: 'owner',
              action: 'ownership.transferred',
              resourceType: 'membership',
              resourceId: String(myMember._id),
              before: { role: 'owner' },
              after: { role: 'admin' },
              requestId: ctx.requestId,
            },
            {
              workspaceId: ctx.workspaceId,
              actorId: ctx.userId,
              actorType: 'user',
              actorRole: 'owner',
              action: 'ownership.received',
              resourceType: 'membership',
              resourceId: String(targetMember._id),
              before: { role: targetMember.role },
              after: { role: 'owner' },
              requestId: ctx.requestId,
            },
          ],
          { session, ordered: true },
        )

        await OutboxEvent.create(
          [{
            workspaceId: ctx.workspaceId,
            type: 'ownership.transferred',
            payload: { from: ctx.userId, to: targetUserId },
            idempotencyKey: `ownership.transferred:${ctx.workspaceId}:${ctx.requestId}`,
            nextAttemptAt: new Date(),
          }],
          { session },
        )
      })
    } catch (err) {
      if (err instanceof AppError) return Result.err(err)
      throw err
    }
    // Both parties' cached roles are now stale — invalidate synchronously.
    await this.invalidateMembershipCache(ctx.workspaceId, ctx.userId)
    await this.invalidateMembershipCache(ctx.workspaceId, targetUserId)
    return Result.ok(undefined)
  }

  /** §7.3 #28 — owner only; sets purgeAfter (+90 d). */
  async deactivateWorkspace(ctx: TenantContext): Promise<Result<void, AppError>> {
    if (ctx.role !== 'owner') {
      return Result.err(new AppError('INSUFFICIENT_PERMISSIONS', 'Only the owner can deactivate the workspace.'))
    }
    const now = new Date()
    await Workspace.updateOne(
      { _id: ctx.workspaceId },
      { $set: { status: 'deactivated', deactivatedAt: now, purgeAfter: new Date(now.getTime() + 90 * DAY_MS) } },
    ).exec()
    return Result.ok(undefined)
  }
}
