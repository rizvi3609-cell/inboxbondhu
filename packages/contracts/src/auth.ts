import { z } from 'zod'
import { bdPhone, emailAddress } from './common.js'

/**
 * Auth API contracts — PRD §2.1 / prompt.md §8, §9 Phase 2.
 * Password policy: ≥ 10 chars, upper + lower + digit; zxcvbn ≥ 3 is enforced
 * in the service (needs the library), not in Zod.
 */
export const passwordPolicy = z
  .string()
  .min(10, 'password must be at least 10 characters')
  .max(128)
  .regex(/[A-Z]/, 'password needs an uppercase letter')
  .regex(/[a-z]/, 'password needs a lowercase letter')
  .regex(/\d/, 'password needs a digit')

export const RegisterBody = z
  .object({
    email: emailAddress,
    password: passwordPolicy,
    name: z.string().trim().min(2).max(80),
    /** Store name for the bootstrap workspace (T4). 1–100, < > & blocked (PRD §2.1). */
    storeName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((v) => !/[<>&]/.test(v), 'store name may not contain < > &'),
    phone: bdPhone.optional(),
  })
  .strict()
export type RegisterBody = z.infer<typeof RegisterBody>

export const LoginBody = z
  .object({
    email: emailAddress,
    password: z.string().min(1).max(128),
  })
  .strict()
export type LoginBody = z.infer<typeof LoginBody>

export const VerifyEmailBody = z.object({ token: z.string().min(32).max(128) }).strict()
export const ResendVerificationBody = z.object({ email: emailAddress }).strict()
export const ForgotPasswordBody = z.object({ email: emailAddress }).strict()
export const ResetPasswordBody = z
  .object({ token: z.string().min(32).max(128), password: passwordPolicy })
  .strict()
export const RequestUnlockOtpBody = z.object({ email: emailAddress }).strict()
export const VerifyUnlockOtpBody = z
  .object({ email: emailAddress, otp: z.string().regex(/^\d{6}$/) })
  .strict()

export const UpdateMeBody = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    phone: bdPhone.nullable().optional(),
  })
  .strict()
export type UpdateMeBody = z.infer<typeof UpdateMeBody>

export const DeactivateMeBody = z.object({ password: z.string().min(1).max(128) }).strict()
