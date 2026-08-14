import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D16 `outboxEvents` — ADR-010. Written INSIDE the business transaction,
 * dispatched AFTER commit by a 5s poller. No external call ever happens
 * inside a transaction (INV-10).
 * idempotencyKey is globally unique — the exactly-once guarantee (DB-06).
 */
const outboxEventSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    type: { type: String, required: true }, // e.g. order.confirmed, email.verification
    payload: { type: Schema.Types.Mixed, required: true }, // ≤ 16 KB
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'dispatched', 'failed', 'dead'],
      default: 'pending',
    },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    nextAttemptAt: { type: Date, required: true },
    dispatchedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

// The dispatcher is one of the four allowlisted skipTenancy bypasses.
outboxEventSchema.plugin(tenancyPlugin)

outboxEventSchema.index(
  { status: 1, nextAttemptAt: 1 },
  { name: 'I51', partialFilterExpression: { status: 'pending' } },
)
// I52 — GLOBAL allowlisted (#3). Exactly-once.
outboxEventSchema.index({ idempotencyKey: 1 }, { unique: true, name: 'I52' })
outboxEventSchema.index({ workspaceId: 1, type: 1, createdAt: -1 }, { name: 'I53' })
outboxEventSchema.index(
  { status: 1, dispatchedAt: 1 },
  { name: 'I54', partialFilterExpression: { status: 'dispatched' } },
)

export type OutboxEventModelDoc = InferSchemaType<typeof outboxEventSchema>
export const OutboxEvent =
  (mongoose.models['OutboxEvent'] as mongoose.Model<InferSchemaType<typeof outboxEventSchema>>) ??
  mongoose.model('OutboxEvent', outboxEventSchema, 'outboxEvents')
