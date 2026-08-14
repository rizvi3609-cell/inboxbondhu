import { z } from 'zod'
import { emailAddress, hhmm, isoDate, moneyMinor, objectIdString } from './common.js'

// ─── workspaces (D03) ────────────────────────────────────────────────────────

export const planEnum = z.enum(['trial', 'starter', 'growth'])
export const workspaceStatus = z.enum(['active', 'suspended', 'deactivated', 'pending_deletion'])
export const roleEnum = z.enum(['owner', 'admin', 'agent', 'viewer'])

export const businessHoursDay = z
  .object({
    day: z.number().int().min(0).max(6),
    open: hhmm,
    close: hhmm,
    closed: z.boolean(),
  })
  .strict()

export const deliveryZone = z
  .object({
    name: z.string().min(1),
    feeMinor: moneyMinor,
    etaDays: z.number().int().min(0),
  })
  .strict()

export const WorkspaceDoc = z
  .object({
    name: z.string().min(2).max(80),
    slug: z.string().regex(/^[a-z0-9-]{3,40}$/),
    ownerId: objectIdString,
    plan: planEnum.default('trial'),
    trialEndsAt: isoDate.nullish(),
    timezone: z.literal('Asia/Dhaka').default('Asia/Dhaka'),
    currency: z.literal('BDT').default('BDT'),
    language: z.literal('bn-en').default('bn-en'),
    businessHours: z
      .object({
        enabled: z.boolean().default(false),
        /** Exactly 7 entries — enforced by a Mongoose custom validator too. */
        days: z.array(businessHoursDay).length(7),
        awayMessage: z.string().max(500).nullish(),
      })
      .strict(),
    aiConfig: z
      .object({
        enabled: z.boolean().default(true),
        tone: z.enum(['friendly', 'formal', 'concise']).default('friendly'),
        autoReplyEnabled: z.boolean().default(true),
        confidenceThreshold: z.number().min(0).max(1).default(0.7),
        handoverKeywords: z.array(z.string()).max(50).default([]),
        /** 0–50 — a direct money-loss control, enforced in three places on purpose. */
        maxDiscountPercent: z.number().int().min(0).max(50).default(50),
        promptVersion: z.string().default('v1'),
      })
      .strict(),
    deliveryZones: z.array(deliveryZone).default([]),
    status: workspaceStatus.default('active'),
    deactivatedAt: isoDate.nullish(),
    purgeAfter: isoDate.nullish(),
    version: z.number().int().min(0).default(0),
  })
  .strict()
export type WorkspaceDoc = z.infer<typeof WorkspaceDoc>

// ─── memberships (D04) — tombstoned, never hard-deleted ─────────────────────

export const MembershipDoc = z
  .object({
    workspaceId: objectIdString,
    userId: objectIdString,
    role: roleEnum,
    invitedBy: objectIdString.nullish(),
    joinedAt: isoDate,
    /** null = active. Tombstone — partial unique index filtered on removedAt: null. */
    removedAt: isoDate.nullish(),
  })
  .strict()
export type MembershipDoc = z.infer<typeof MembershipDoc>

// ─── invitations (D05) — role can NEVER be 'owner' ──────────────────────────

export const invitationRole = z.enum(['admin', 'agent', 'viewer'])
export const invitationStatus = z.enum(['pending', 'accepted', 'revoked', 'expired'])

export const InvitationDoc = z
  .object({
    workspaceId: objectIdString,
    email: emailAddress,
    role: invitationRole,
    tokenHash: z.string().length(64),
    invitedBy: objectIdString,
    status: invitationStatus.default('pending'),
    /** TTL 0 = createdAt + 7d. */
    expiresAt: isoDate,
    acceptedAt: isoDate.nullish(),
    acceptedUserId: objectIdString.nullish(),
  })
  .strict()
export type InvitationDoc = z.infer<typeof InvitationDoc>
