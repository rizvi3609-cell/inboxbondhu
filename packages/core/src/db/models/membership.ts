import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D04 `memberships` — tombstoned, NEVER hard-deleted (remove-then-reinvite).
 * Uniqueness: partial index {workspaceId, userId} filtered removedAt: null.
 * Exactly one owner per workspace is enforced by transaction T3, not an index.
 */
const membershipSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    role: { type: String, required: true, enum: ['owner', 'admin', 'agent', 'viewer'] },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt: { type: Date, required: true },
    removedAt: { type: Date, default: null }, // null = active
  },
  { timestamps: true, strict: 'throw' },
)

membershipSchema.plugin(tenancyPlugin)

// I12 — UP filtered on removedAt: null. TenantContext build.
membershipSchema.index(
  { workspaceId: 1, userId: 1 },
  { unique: true, name: 'I12', partialFilterExpression: { removedAt: null } },
)
membershipSchema.index({ userId: 1, removedAt: 1 }, { name: 'I13' })
membershipSchema.index({ workspaceId: 1, role: 1 }, { name: 'I14' })

export type MembershipModelDoc = InferSchemaType<typeof membershipSchema>
export const Membership =
  (mongoose.models['Membership'] as mongoose.Model<InferSchemaType<typeof membershipSchema>>) ??
  mongoose.model('Membership', membershipSchema, 'memberships')
