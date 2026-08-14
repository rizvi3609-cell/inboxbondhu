import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D08 `conversations`.
 * lastMessagePreview/Direction are denormalised ON PURPOSE (inbox renders 30
 * rows without 30 lookups into 600k messages).
 * metaWindowExpiresAt is a HARD compliance gate (OQ-14: never bypass with
 * HUMAN_AGENT). countedForBilling makes plan counting idempotent.
 */
const conversationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    channelConnectionId: { type: Schema.Types.ObjectId, required: true, ref: 'ChannelConnection' },
    customerId: { type: Schema.Types.ObjectId, required: true, ref: 'Customer' },
    status: { type: String, required: true, enum: ['open', 'pending', 'resolved'], default: 'open' },
    mode: { type: String, required: true, enum: ['ai', 'human'], default: 'ai' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    // OPEN QUESTION: handoverReason enum given in prose only (database.md §2.8);
    // implemented narrow snake_case values pending exact wire format.
    handoverReason: {
      type: String,
      enum: ['low_confidence', 'keyword', 'explicit_request', 'complaint', 'repeated_failure', null],
      default: null,
    },
    lastMessageAt: { type: Date, required: true }, // primary inbox sort key
    lastMessagePreview: { type: String, maxlength: 140, default: null },
    lastMessageDirection: { type: String, enum: ['inbound', 'outbound', null], default: null },
    unreadCount: { type: Number, required: true, default: 0, min: 0 },
    messageCount: { type: Number, required: true, default: 0, min: 0 },
    metaWindowExpiresAt: { type: Date, default: null }, // last inbound + 24h — hard gate
    countedForBilling: { type: Boolean, required: true, default: false },
    billingPeriodKey: { type: String, match: /^\d{4}-(0[1-9]|1[0-2])$/, default: null },
    tags: {
      type: [String],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 20, message: 'max 20 tags' },
    },
    purgeAfter: { type: Date, required: true }, // lastMessageAt + 90d
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

conversationSchema.plugin(tenancyPlugin)
conversationSchema.plugin(occPlugin)

// I24 — THE inbox list index (hottest query in the product). ESR.
conversationSchema.index({ workspaceId: 1, status: 1, lastMessageAt: -1 }, { name: 'I24' })
conversationSchema.index(
  { workspaceId: 1, assignedTo: 1, status: 1, lastMessageAt: -1 },
  { name: 'I25' },
)
conversationSchema.index({ workspaceId: 1, customerId: 1, lastMessageAt: -1 }, { name: 'I26' })
conversationSchema.index({ purgeAfter: 1 }, { name: 'I27' })
conversationSchema.index(
  { workspaceId: 1, billingPeriodKey: 1, countedForBilling: 1 },
  { name: 'I27b' },
)

export type ConversationModelDoc = InferSchemaType<typeof conversationSchema>
export const Conversation =
  (mongoose.models['Conversation'] as mongoose.Model<InferSchemaType<typeof conversationSchema>>) ??
  mongoose.model('Conversation', conversationSchema, 'conversations')
