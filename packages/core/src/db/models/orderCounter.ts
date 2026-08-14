import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D13 `orderCounters` — _id is the STRING "{workspaceId}:{year}".
 * workspaceId + year stored redundantly so the collection is queryable and
 * tenant-filterable without string parsing.
 * Gaps in the sequence are INTENTIONAL (aborted tx consumes a number).
 * Never build a gap-filler. Rows are never deleted.
 */
const orderCounterSchema = new Schema(
  {
    _id: { type: String, required: true, match: /^[0-9a-fA-F]{24}:\d{4}$/ },
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    year: { type: Number, required: true },
    seq: { type: Number, required: true, default: 0, min: 0 },
    updatedAt: { type: Date, required: true },
  },
  { timestamps: false, strict: 'throw', _id: false },
)

orderCounterSchema.plugin(tenancyPlugin)

// The $inc upsert uses _id; I44b is admin reporting only.
orderCounterSchema.index({ workspaceId: 1, year: 1 }, { name: 'I44b' })

export type OrderCounterModelDoc = InferSchemaType<typeof orderCounterSchema>
export const OrderCounter =
  (mongoose.models['OrderCounter'] as mongoose.Model<InferSchemaType<typeof orderCounterSchema>>) ??
  mongoose.model('OrderCounter', orderCounterSchema, 'orderCounters')

/**
 * The ONLY correct way to obtain an order number (prompt.md §5.2).
 * Atomic, single-document, safe under any concurrency, works inside a transaction.
 */
export async function nextOrderCode(
  workspaceId: string,
  year: number,
  session?: mongoose.ClientSession,
): Promise<{ orderNumber: number; orderCode: string }> {
  const doc = await OrderCounter.findOneAndUpdate(
    { _id: `${workspaceId}:${year}`, workspaceId },
    { $inc: { seq: 1 }, $setOnInsert: { year }, $set: { updatedAt: new Date() } },
    { upsert: true, new: true, ...(session ? { session } : {}) },
  )
  const seq = doc!.seq
  return { orderNumber: seq, orderCode: `ORD-${year}-${String(seq).padStart(5, '0')}` }
}
