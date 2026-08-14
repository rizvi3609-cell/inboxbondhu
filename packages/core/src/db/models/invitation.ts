import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D05 `invitations` — role can NEVER be 'owner'; ownership moves only via T3.
 * Max 20 pending is a countDocuments guard in the service (may briefly
 * overshoot under concurrency — accepted and documented).
 */
const invitationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    email: { type: String, required: true, maxlength: 320, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    role: { type: String, required: true, enum: ['admin', 'agent', 'viewer'] }, // never 'owner'
    tokenHash: { type: String, required: true, minlength: 64, maxlength: 64 },
    invitedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'accepted', 'revoked', 'expired'],
      default: 'pending',
    },
    expiresAt: { type: Date, required: true }, // createdAt + 7d
    acceptedAt: { type: Date, default: null },
    acceptedUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

invitationSchema.pre('validate', function (next) {
  if (typeof this.email === 'string') this.email = this.email.trim().toLowerCase()
  next()
})

invitationSchema.plugin(tenancyPlugin)

invitationSchema.index({ tokenHash: 1 }, { unique: true, name: 'I15' })
invitationSchema.index({ workspaceId: 1, status: 1, email: 1 }, { name: 'I16' })
invitationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'I17' })

export type InvitationModelDoc = InferSchemaType<typeof invitationSchema>
export const Invitation =
  (mongoose.models['Invitation'] as mongoose.Model<InferSchemaType<typeof invitationSchema>>) ??
  mongoose.model('Invitation', invitationSchema, 'invitations')
