import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { moneyPlugin } from '../plugins/money.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D09 `messages` — highest volume (~600k docs).
 * - NO version field: append-mostly; the only writes are single-doc status $sets.
 * - providerMessageId: unique SPARSE with workspaceId (I29) — THE dedupe key.
 * - Attachments store a Spaces key, NEVER a Meta CDN URL (they expire).
 * - Four indexes only — that is the budget. Do not add a fifth.
 */
const attachmentSchema = new Schema(
  {
    type: { type: String, required: true },
    spacesKey: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    width: { type: Number, min: 0, default: null },
    height: { type: Number, min: 0, default: null },
  },
  { _id: false },
)

const messageSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    conversationId: { type: Schema.Types.ObjectId, required: true, ref: 'Conversation' },
    direction: { type: String, required: true, enum: ['inbound', 'outbound'] },
    author: {
      type: {
        type: String,
        required: true,
        enum: ['customer', 'ai', 'agent', 'system'],
      },
      userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    },
    contentType: {
      type: String,
      required: true,
      enum: ['text', 'image', 'audio', 'video', 'file', 'template', 'postback'],
    },
    text: { type: String, maxlength: 4000, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    providerMessageId: { type: String, default: null }, // Meta MID
    status: {
      type: String,
      required: true,
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
      default: 'queued',
    },
    failureCode: { type: String, default: null },
    failureDetail: { type: String, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    aiMeta: {
      type: new Schema(
        {
          intent: {
            type: String,
            enum: [
              'greeting', 'product_search', 'price_question', 'availability_question',
              'delivery_question', 'size_or_color_question', 'order_start',
              'provide_customer_detail', 'order_confirmation', 'payment_question',
              'complaint', 'human_request', 'unknown',
            ],
            default: null,
          },
          confidence: { type: Number, min: 0, max: 1, default: null },
          /** Grounding proof — what the AI was ALLOWED to say. */
          sourceIds: { type: [Schema.Types.ObjectId], default: [] },
          model: { type: String, default: null },
          promptVersion: { type: String, default: null },
          latencyMs: { type: Number, min: 0, default: null },
          costMinor: { type: Number, min: 0, default: null },
          groundingBlocked: { type: Boolean, default: null },
          blockReason: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

// DB-unenforceable rule #8: author.userId required IFF author.type === 'agent'.
messageSchema.pre('validate', function (next) {
  const author = this.get('author') as { type?: string; userId?: unknown } | undefined
  if (author?.type === 'agent' && author.userId == null) {
    this.invalidate('author.userId', 'author.userId is required when author.type is "agent"')
  }
  if (author && author.type !== 'agent' && author.userId != null) {
    this.invalidate('author.userId', 'author.userId is only allowed when author.type is "agent"')
  }
  next()
})

messageSchema.plugin(tenancyPlugin)
messageSchema.plugin(moneyPlugin)

// The four-index budget — deliberately no more.
messageSchema.index({ conversationId: 1, createdAt: 1 }, { name: 'I28' }) // thread rendering (DB-02)
// I29 — "U sparse" in the catalogue. On a COMPOUND index, `sparse` only skips
// docs missing ALL keys; workspaceId is always present, so two outbound
// messages with providerMessageId:null would collide. A partial filter gives
// the intended semantics, and database.md §4.1 rule 4 prefers partial over
// sparse where the filter is known.
messageSchema.index(
  { workspaceId: 1, providerMessageId: 1 },
  {
    unique: true,
    name: 'I29',
    partialFilterExpression: { providerMessageId: { $type: 'string' } },
  },
)
messageSchema.index(
  { status: 1, createdAt: 1 },
  { name: 'I30', partialFilterExpression: { status: 'queued' } },
)
messageSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'I31' })

export type MessageModelDoc = InferSchemaType<typeof messageSchema>
export const Message =
  (mongoose.models['Message'] as mongoose.Model<InferSchemaType<typeof messageSchema>>) ??
  mongoose.model('Message', messageSchema, 'messages')
