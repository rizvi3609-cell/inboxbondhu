import mongoose, { Schema, type InferSchemaType } from 'mongoose'
import { occPlugin } from '../plugins/occ.js'
import { tenancyPlugin } from '../plugins/tenancy.js'

/**
 * D06 `channelConnections`.
 * ADR-013 — the ONE deliberate tenancy exception on indexing:
 * {provider, externalPageId} is globally unique with NO workspaceId prefix,
 * because Meta keys webhooks by page ID alone. The E11000 from this index IS
 * the "already connected to another workspace" error (US-008 AC-3).
 * Disconnect is SOFT: status 'revoked', token fields zeroed, row retained.
 */
const channelConnectionSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, required: true, ref: 'Workspace' },
    provider: { type: String, required: true, enum: ['facebook', 'instagram'] },
    externalPageId: { type: String, required: true },
    pageName: { type: String, required: true },
    // AES-256-GCM envelope encryption — NEVER plaintext, never logged, never returned.
    accessTokenCipher: { type: String, required: true },
    accessTokenIv: { type: String, required: true }, // base64, 12 bytes
    accessTokenTag: { type: String, required: true }, // base64, 16 bytes
    keyVersion: { type: Number, required: true, default: 1, min: 1 },
    tokenExpiresAt: { type: Date, default: null },
    scopes: { type: [String], required: true, default: [] },
    status: {
      type: String,
      required: true,
      enum: ['active', 'expired', 'revoked', 'error'],
      default: 'active',
    },
    lastErrorCode: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    subscribedFields: { type: [String], required: true, default: [] },
    connectedBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    version: { type: Number, required: true, default: 0, min: 0 }, // OCC
  },
  { timestamps: true, strict: 'throw' },
)

channelConnectionSchema.plugin(tenancyPlugin)
channelConnectionSchema.plugin(occPlugin)

// I18 — GLOBAL allowlisted (#1). ADR-013.
channelConnectionSchema.index({ provider: 1, externalPageId: 1 }, { unique: true, name: 'I18' })
channelConnectionSchema.index({ workspaceId: 1, status: 1 }, { name: 'I19' })
channelConnectionSchema.index(
  { tokenExpiresAt: 1 },
  { name: 'I20', partialFilterExpression: { status: 'active' } },
)

export type ChannelConnectionModelDoc = InferSchemaType<typeof channelConnectionSchema>
export const ChannelConnection =
  (mongoose.models['ChannelConnection'] as mongoose.Model<InferSchemaType<typeof channelConnectionSchema>>) ??
  mongoose.model('ChannelConnection', channelConnectionSchema, 'channelConnections')
