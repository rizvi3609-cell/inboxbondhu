import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D19 `imports` — CSV import job state.
 * lastProcessedRow is the resume checkpoint (every 100 rows) — a worker crash
 * costs at most 100 rows of rework and never causes duplicates (US-011).
 * errors[] capped at 500 — beyond that the full report belongs in Spaces.
 */
const importErrorSchema = new Schema(
  {
    row: { type: Number, required: true, min: 0 },
    column: { type: String, required: true },
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
)

const importSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    type: { type: String, required: true, enum: ['products_csv'] },
    fileName: { type: String, required: true },
    spacesKey: { type: String, required: true },
    totalRows: { type: Number, required: true, min: 0 },
    lastProcessedRow: { type: Number, required: true, default: 0, min: 0 },
    successCount: { type: Number, required: true, default: 0, min: 0 },
    failureCount: { type: Number, required: true, default: 0, min: 0 },
    errors: {
      type: [importErrorSchema],
      default: [],
      validate: { validator: (v: unknown[]) => v.length <= 500, message: 'errors[] capped at 500' },
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  // `errors` is the documented field name (database.md §2.19). Mongoose warns
  // because it shadows Document#errors; suppress — access via .get('errors').
  { timestamps: true, strict: 'throw', suppressReservedKeysWarning: true },
)

importSchema.plugin(tenancyPlugin)

importSchema.index({ workspaceId: 1, status: 1, createdAt: -1 }, { name: 'I59' })

export type ImportModelDoc = InferSchemaType<typeof importSchema>
export const Import =
  (mongoose.models['Import'] as mongoose.Model<InferSchemaType<typeof importSchema>>) ??
  mongoose.model('Import', importSchema, 'imports')
