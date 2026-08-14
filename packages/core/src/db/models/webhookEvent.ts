import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D15 `webhookEvents` — the ONE collection with an optional workspaceId
 * (conflict DB-06): dedupe happens BEFORE tenant resolution. On the
 * tenancy-plugin exemption list.
 *
 * dedupeKey = `{provider}:{pageId}:{mid}` — PLAINTEXT, never hashed. The Redis
 * `wh:` prefix is a cache-key concern and never part of this stored value.
 * Redis TTL (24h) < retention (7d): a redelivery older than 24h passes the
 * Redis gate and is caught only by the I48 duplicate-key error — catch it and
 * treat it as a successful dedupe, not a fault.
 */
const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ['facebook', 'instagram'] },
    externalPageId: { type: String, required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: 'Workspace', default: null }, // optional — orphans
    dedupeKey: { type: String, required: true },
    signatureValid: { type: Boolean, required: true },
    rawPayload: { type: Schema.Types.Mixed, required: true }, // ≤ 100 KB — NEVER logged
    receivedAt: { type: Date, required: true },
    processStatus: {
      type: String,
      required: true,
      enum: ['pending', 'processed', 'failed', 'orphaned', 'invalid_signature'],
      default: 'pending',
    },
    processedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    lastError: { type: String, default: null },
    expiresAt: { type: Date, required: true }, // receivedAt + 7d (OQ-11: do not extend)
  },
  { timestamps: false, strict: 'throw' },
)

webhookEventSchema.plugin(tenancyPlugin, { exempt: true }) // tenant unknown at dedupe time

// I48 — GLOBAL allowlisted (#2). Durable replay protection.
webhookEventSchema.index({ dedupeKey: 1 }, { unique: true, name: 'I48' })
webhookEventSchema.index(
  { processStatus: 1, receivedAt: 1 },
  { name: 'I49', partialFilterExpression: { processStatus: 'pending' } },
)
webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'I50' })

export type WebhookEventModelDoc = InferSchemaType<typeof webhookEventSchema>
export const WebhookEvent =
  (mongoose.models['WebhookEvent'] as mongoose.Model<InferSchemaType<typeof webhookEventSchema>>) ??
  mongoose.model('WebhookEvent', webhookEventSchema, 'webhookEvents')
