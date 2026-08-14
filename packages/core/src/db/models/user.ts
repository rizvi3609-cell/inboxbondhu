import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D01 `users` — GLOBAL identity, no workspaceId. Tenancy-EXEMPT.
 */
const userSchema = new Schema(
  {
    ulid: { type: String, required: true, minlength: 26, maxlength: 26 },
    email: {
      type: String,
      required: true,
      maxlength: 320,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    emailVerifiedAt: { type: Date, default: null },
    /**
     * TRAP: select:false. Exactly ONE place may `.select('+passwordHash')`:
     * the login use case (Phase 2).
     */
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, minlength: 2, maxlength: 80 },
    phone: { type: String, match: /^01[3-9]\d{8}$/, default: null },
    locale: { type: String, required: true, enum: ['bn-en'], default: 'bn-en' },
    status: {
      type: String,
      required: true,
      enum: ['active', 'deactivated', 'pending_deletion'],
      default: 'active',
    },
    deactivatedAt: { type: Date, default: null },
    purgeAfter: { type: Date, default: null },
    /**
     * TRAP — the single most misimplemented rule in the schema:
     * cumulative, NEVER reset by a successful login. Resets only on
     * successful OTP unlock or password reset.
     */
    failedLoginCount: { type: Number, required: true, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
    unlockOtpHash: { type: String, default: null },
    unlockOtpExpiresAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
)

// Email normalisation (lowercase + trim) happens HERE, never at the call site.
userSchema.pre('validate', function (next) {
  if (typeof this.email === 'string') this.email = this.email.trim().toLowerCase()
  next()
})

userSchema.plugin(tenancyPlugin, { exempt: true }) // global identity

// I01–I03
userSchema.index({ email: 1 }, { unique: true, name: 'I01' })
userSchema.index({ ulid: 1 }, { unique: true, name: 'I02' })
userSchema.index(
  { purgeAfter: 1 },
  { name: 'I03', partialFilterExpression: { status: 'pending_deletion' } },
)

export type UserModelDoc = InferSchemaType<typeof userSchema>
export const User =
  (mongoose.models['User'] as mongoose.Model<InferSchemaType<typeof userSchema>>) ??
  mongoose.model('User', userSchema, 'users')
