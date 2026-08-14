import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D11 `knowledgeItems`.
 * DELIBERATE (do not harmonise): answer ≤ 2000 HERE, ≤ 500 at the API edge —
 * an LLM context-budget control (agent.md gotcha #7).
 * AI reads status:'approved' ONLY, filtered INSIDE the retrieval query.
 */
const knowledgeItemSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    question: { type: String, required: true, minlength: 5, maxlength: 500 },
    answer: { type: String, required: true, minlength: 5, maxlength: 2000 },
    category: {
      type: String,
      enum: ['delivery', 'payment', 'return', 'sizing', 'general', null],
      default: null,
    },
    keywords: {
      type: [String],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 20, message: 'max 20 keywords' },
      set: (v: string[]) => v.map((k) => k.toLowerCase()),
    },
    status: { type: String, required: true, enum: ['draft', 'approved', 'archived'], default: 'draft' },
    searchText: { type: String, required: true, default: '' },
    usageCount: { type: Number, required: true, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

knowledgeItemSchema.pre('validate', function (next) {
  this.searchText = [this.question, this.answer, ...(this.keywords ?? [])]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  next()
})

knowledgeItemSchema.plugin(tenancyPlugin)
knowledgeItemSchema.plugin(occPlugin)

knowledgeItemSchema.index({ workspaceId: 1, searchText: 'text' }, { name: 'I37' }) // AI FAQ retrieval
knowledgeItemSchema.index({ workspaceId: 1, status: 1, category: 1 }, { name: 'I37b' })

export type KnowledgeItemModelDoc = InferSchemaType<typeof knowledgeItemSchema>
export const KnowledgeItem =
  (mongoose.models['KnowledgeItem'] as mongoose.Model<InferSchemaType<typeof knowledgeItemSchema>>) ??
  mongoose.model('KnowledgeItem', knowledgeItemSchema, 'knowledgeItems')
