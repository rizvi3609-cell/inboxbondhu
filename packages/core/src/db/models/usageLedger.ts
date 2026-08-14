import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { moneyPlugin } from '../plugins/money.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D17 `usageLedger` — Mongo is AUTHORITATIVE; Redis is the fast counter.
 * The hourly reconciler recomputes from `conversations` and corrects Redis —
 * never the reverse. conversationsLimit is snapshotted at period start.
 * Retention: 13 months.
 */
const usageLedgerSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    periodKey: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    plan: { type: String, required: true, enum: ['trial', 'starter', 'growth'] },
    conversationsUsed: { type: Number, required: true, default: 0, min: 0 },
    conversationsLimit: { type: Number, required: true, min: 0 }, // snapshot — 100/1000/5000
    productsCount: { type: Number, required: true, default: 0, min: 0 },
    aiRepliesGenerated: { type: Number, required: true, default: 0, min: 0 },
    aiCostMinor: { type: Number, required: true, default: 0, min: 0 },
    messagesSent: { type: Number, required: true, default: 0, min: 0 },
    warningsSentAt: { type: [Date], default: [] },
    reconciledAt: { type: Date, default: null },
  },
  { timestamps: true, strict: 'throw' },
)

usageLedgerSchema.plugin(tenancyPlugin)
usageLedgerSchema.plugin(moneyPlugin)

usageLedgerSchema.index({ workspaceId: 1, periodKey: 1 }, { unique: true, name: 'I55' })
usageLedgerSchema.index({ periodKey: 1, plan: 1 }, { name: 'I56' })

export type UsageLedgerModelDoc = InferSchemaType<typeof usageLedgerSchema>
export const UsageLedger =
  (mongoose.models['UsageLedger'] as mongoose.Model<InferSchemaType<typeof usageLedgerSchema>>) ??
  mongoose.model('UsageLedger', usageLedgerSchema, 'usageLedger')
