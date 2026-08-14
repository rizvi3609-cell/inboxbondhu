import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D02 `sessions` — GLOBAL (user-scoped, not workspace-scoped). Tenancy-EXEMPT.
 * Refresh-token families; max 5 concurrent with LRU eviction by lastUsedAt.
 * Rotation INSERTS a new doc and marks the old one 'rotated' — never in place.
 * The TTL index reclaims space; revokedAt is the security control.
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    familyId: { type: String, required: true, minlength: 26, maxlength: 26 },
    refreshTokenHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    generation: { type: Number, required: true, default: 0, min: 0 },
    userAgent: { type: String, required: true, maxlength: 300 },
    ipHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, // createdAt + 30d
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ['logout', 'reuse_detected', 'evicted', 'member_removed', 'password_changed', 'rotated'],
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

sessionSchema.plugin(tenancyPlugin, { exempt: true })

// I04 — global allowlisted (#4): sessions are user-scoped, not workspace-scoped.
sessionSchema.index({ refreshTokenHash: 1 }, { unique: true, name: 'I04' })
// I05 — LRU eviction by lastUsedAt (NOT createdAt).
sessionSchema.index({ userId: 1, lastUsedAt: -1 }, { name: 'I05' })
sessionSchema.index({ familyId: 1 }, { name: 'I06' })
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'I07' })

export type SessionModelDoc = InferSchemaType<typeof sessionSchema>
export const Session =
  (mongoose.models['Session'] as mongoose.Model<InferSchemaType<typeof sessionSchema>>) ??
  mongoose.model('Session', sessionSchema, 'sessions')
