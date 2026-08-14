import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D14 `stockReservations`.
 * DELIBERATELY NO TTL INDEX on expiresAt (DB-07): a TTL delete would remove
 * the row while leaving variants.$.reserved incremented — permanently leaking
 * stock. The reservationExpirySweeper decrements `reserved` and marks the row
 * `released` IN ONE TRANSACTION. The two halves must never be separable.
 */
const stockReservationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    orderId: { type: Schema.Types.ObjectId, required: true, ref: 'Order' },
    productId: { type: Schema.Types.ObjectId, required: true, ref: 'Product' },
    variantSku: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, enum: ['held', 'committed', 'released'], default: 'held' },
    expiresAt: { type: Date, required: true }, // createdAt + 24h — NO TTL INDEX
    releasedAt: { type: Date, default: null },
    committedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

stockReservationSchema.plugin(tenancyPlugin)

stockReservationSchema.index({ workspaceId: 1, orderId: 1 }, { name: 'I45' }) // release-on-cancel (DB-04)
stockReservationSchema.index(
  { status: 1, expiresAt: 1 },
  { name: 'I46', partialFilterExpression: { status: 'held' } }, // 5-min sweeper — NOT a TTL
)
stockReservationSchema.index(
  { workspaceId: 1, productId: 1, variantSku: 1, status: 1 },
  { name: 'I47' }, // nightly reconciliation
)

export type StockReservationModelDoc = InferSchemaType<typeof stockReservationSchema>
export const StockReservation =
  (mongoose.models['StockReservation'] as mongoose.Model<InferSchemaType<typeof stockReservationSchema>>) ??
  mongoose.model('StockReservation', stockReservationSchema, 'stockReservations')
