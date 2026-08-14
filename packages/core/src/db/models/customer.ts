import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { moneyPlugin } from '../plugins/money.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D07 `customers` — the end buyer, never an account holder.
 * Key is THREE fields {workspaceId, provider, externalUserId} (conflict DB-03):
 * a Facebook PSID and an Instagram IGSID can collide numerically.
 * `phoneHash` survives the 90-day anonymisation; `phone` does not.
 */
const customerSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    provider: { type: String, required: true, enum: ['facebook', 'instagram'] },
    externalUserId: { type: String, required: true },
    displayName: { type: String, required: true },
    profilePicUrl: { type: String, default: null }, // expiring Meta CDN URL — never cache
    phone: { type: String, match: /^01[3-9]\d{8}$/, default: null }, // PII
    phoneHash: { type: String, minlength: 64, maxlength: 64, default: null }, // survives anonymisation
    addressText: { type: String, maxlength: 500, default: null }, // PII
    deliveryZone: { type: String, default: null },
    tags: {
      type: [String],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 20, message: 'max 20 tags' },
    },
    notes: { type: String, maxlength: 2000, default: null },
    orderCount: { type: Number, required: true, default: 0, min: 0 }, // via outbox, eventually consistent
    totalSpentMinor: { type: Number, required: true, default: 0, min: 0 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    anonymizedAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
)

customerSchema.plugin(tenancyPlugin)
customerSchema.plugin(moneyPlugin)

// I21 — the 3-field unique key (DB-03).
customerSchema.index(
  { workspaceId: 1, provider: 1, externalUserId: 1 },
  { unique: true, name: 'I21' },
)
customerSchema.index({ workspaceId: 1, phoneHash: 1 }, { sparse: true, name: 'I22' })
customerSchema.index({ workspaceId: 1, lastSeenAt: -1 }, { name: 'I23' })

export type CustomerModelDoc = InferSchemaType<typeof customerSchema>
export const Customer =
  (mongoose.models['Customer'] as mongoose.Model<InferSchemaType<typeof customerSchema>>) ??
  mongoose.model('Customer', customerSchema, 'customers')
