import { z } from 'zod'
import { emailAddress, hhmm, moneyMinor, objectIdString } from './common.js'

/** Workspace/membership/invitation API bodies — prompt.md §9 Phase 2 items 9–13. */

export const CreateWorkspaceBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .refine((v) => !/[<>&]/.test(v), 'name may not contain < > &'),
  })
  .strict()
export type CreateWorkspaceBody = z.infer<typeof CreateWorkspaceBody>

export const UpdateWorkspaceBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .refine((v) => !/[<>&]/.test(v), 'name may not contain < > &')
      .optional(),
    businessHours: z
      .object({
        enabled: z.boolean(),
        days: z
          .array(
            z
              .object({
                day: z.number().int().min(0).max(6),
                open: hhmm,
                close: hhmm,
                closed: z.boolean(),
              })
              .strict(),
          )
          .length(7),
        awayMessage: z.string().max(500).nullish(),
      })
      .strict()
      .optional(),
    aiConfig: z
      .object({
        enabled: z.boolean().optional(),
        tone: z.enum(['friendly', 'formal', 'concise']).optional(),
        autoReplyEnabled: z.boolean().optional(),
        confidenceThreshold: z.number().min(0).max(1).optional(),
        handoverKeywords: z.array(z.string()).max(50).optional(),
        maxDiscountPercent: z.number().int().min(0).max(50).optional(),
      })
      .strict()
      .optional(),
    deliveryZones: z
      .array(z.object({ name: z.string().min(1), feeMinor: moneyMinor, etaDays: z.number().int().min(0) }).strict())
      .optional(),
  })
  .strict()
export type UpdateWorkspaceBody = z.infer<typeof UpdateWorkspaceBody>

export const ChangeRoleBody = z
  .object({ role: z.enum(['admin', 'agent', 'viewer']) }) // owner only via T3
  .strict()
export type ChangeRoleBody = z.infer<typeof ChangeRoleBody>

export const CreateInvitationBody = z
  .object({
    email: emailAddress,
    role: z.enum(['admin', 'agent', 'viewer']), // never 'owner'
  })
  .strict()
export type CreateInvitationBody = z.infer<typeof CreateInvitationBody>

export const TransferOwnershipBody = z
  .object({
    password: z.string().min(1).max(128), // owner re-auth
    targetUserId: objectIdString,
  })
  .strict()
export type TransferOwnershipBody = z.infer<typeof TransferOwnershipBody>
