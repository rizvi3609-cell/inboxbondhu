import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { moneyPlugin } from '../plugins/money.js'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D03 `workspaces` — _id IS the tenant id. Self-scoped: queries address it by
 * _id, so the tenancy plugin treats it as exempt at the plugin level; the
 * repository layer must always resolve by ctx.workspaceId.
 */
const businessHoursDaySchema = new Schema(
  {
    day: { type: Number, required: true, min: 0, max: 6 },
    open: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    close: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    closed: { type: Boolean, required: true, default: false },
  },
  { _id: false },
)

const deliveryZoneSchema = new Schema(
  {
    name: { type: String, required: true },
    feeMinor: { type: Number, required: true, min: 0 },
    etaDays: { type: Number, required: true, min: 0 },
  },
  { _id: false },
)

const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, minlength: 2, maxlength: 80 },
    slug: { type: String, required: true, match: /^[a-z0-9-]{3,40}$/ },
    ownerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    plan: { type: String, required: true, enum: ['trial', 'starter', 'growth'], default: 'trial' },
    trialEndsAt: { type: Date, default: null },
    timezone: { type: String, required: true, enum: ['Asia/Dhaka'], default: 'Asia/Dhaka' },
    currency: { type: String, required: true, enum: ['BDT'], default: 'BDT' },
    language: { type: String, required: true, enum: ['bn-en'], default: 'bn-en' },
    businessHours: {
      enabled: { type: Boolean, required: true, default: false },
      days: {
        type: [businessHoursDaySchema],
        required: true,
        // DB-unenforceable rule #8-adjacent: exactly 7 entries (prompt.md §9 Phase 1 item 8).
        validate: {
          validator: (v: unknown[]) => Array.isArray(v) && v.length === 7,
          message: 'businessHours.days must have exactly 7 entries',
        },
      },
      awayMessage: { type: String, maxlength: 500, default: null },
    },
    aiConfig: {
      enabled: { type: Boolean, required: true, default: true },
      tone: { type: String, required: true, enum: ['friendly', 'formal', 'concise'], default: 'friendly' },
      autoReplyEnabled: { type: Boolean, required: true, default: true },
      confidenceThreshold: { type: Number, required: true, min: 0, max: 1, default: 0.7 },
      handoverKeywords: {
        type: [String],
        required: true,
        default: [],
        validate: { validator: (v: unknown[]) => v.length <= 50, message: 'max 50 handover keywords' },
      },
      /** ≤ 50 — direct money-loss control, enforced at Zod edge + here + AI gate. */
      maxDiscountPercent: { type: Number, required: true, min: 0, max: 50, default: 50 },
      promptVersion: { type: String, required: true, default: 'v1' },
    },
    deliveryZones: { type: [deliveryZoneSchema], required: true, default: [] },
    status: {
      type: String,
      required: true,
      enum: ['active', 'suspended', 'deactivated', 'pending_deletion'],
      default: 'active',
    },
    deactivatedAt: { type: Date, default: null },
    purgeAfter: { type: Date, default: null },
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

workspaceSchema.plugin(tenancyPlugin, { exempt: true }) // self-scoped by _id
workspaceSchema.plugin(occPlugin)
workspaceSchema.plugin(moneyPlugin)

workspaceSchema.index({ slug: 1 }, { unique: true, name: 'I08' })
workspaceSchema.index({ ownerId: 1 }, { name: 'I09' })
workspaceSchema.index(
  { purgeAfter: 1 },
  { name: 'I10', partialFilterExpression: { status: 'pending_deletion' } },
)
workspaceSchema.index(
  { plan: 1, trialEndsAt: 1 },
  { name: 'I11', partialFilterExpression: { plan: 'trial' } },
)

export type WorkspaceModelDoc = InferSchemaType<typeof workspaceSchema>
export const Workspace =
  (mongoose.models['Workspace'] as mongoose.Model<InferSchemaType<typeof workspaceSchema>>) ??
  mongoose.model('Workspace', workspaceSchema, 'workspaces')
