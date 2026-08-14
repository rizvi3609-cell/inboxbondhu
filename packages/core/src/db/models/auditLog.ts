import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D18 `auditLogs` — append-only.
 * actorRole is the role held AT THE TIME of the action — snapshotted, never
 * resolved from today's memberships (agent.md gotcha #18).
 * before/after: changed fields only, PII-redacted.
 * Retention unbounded pending OQ-05 — leave unbounded.
 */
const auditLogSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    actorId: { type: String, required: true }, // ObjectId string OR 'system'
    actorType: { type: String, required: true, enum: ['user', 'system', 'ai'] },
    actorRole: { type: String, enum: ['owner', 'admin', 'agent', 'viewer', null], default: null },
    action: { type: String, required: true, match: /^[a-z_]+\.[a-z_]+$/ }, // resource.verb
    resourceType: { type: String, required: true },
    resourceId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, required: true, minlength: 26, maxlength: 26 }, // ULID (ADR-009)
    ipHash: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
)

auditLogSchema.plugin(tenancyPlugin)

auditLogSchema.index({ workspaceId: 1, createdAt: -1 }, { name: 'I57' })
auditLogSchema.index(
  { workspaceId: 1, resourceType: 1, resourceId: 1, createdAt: -1 },
  { name: 'I58' },
)
auditLogSchema.index({ requestId: 1 }, { name: 'I58b' })

export type AuditLogModelDoc = InferSchemaType<typeof auditLogSchema>
export const AuditLog =
  (mongoose.models['AuditLog'] as mongoose.Model<InferSchemaType<typeof auditLogSchema>>) ??
  mongoose.model('AuditLog', auditLogSchema, 'auditLogs')
