import { z } from 'zod'
import { isoDate, objectIdString, providerEnum } from './common.js'

// ─── channelConnections (D06) ────────────────────────────────────────────────

export const channelStatus = z.enum(['active', 'expired', 'revoked', 'error'])

export const ChannelConnectionDoc = z
  .object({
    workspaceId: objectIdString,
    provider: providerEnum,
    /** ADR-013: {provider, externalPageId} is globally unique — NO workspaceId prefix. */
    externalPageId: z.string().min(1),
    pageName: z.string().min(1),
    /** AES-256-GCM envelope encryption. NEVER plaintext, never logged, never returned. */
    accessTokenCipher: z.string(),
    accessTokenIv: z.string(), // base64, 12 bytes
    accessTokenTag: z.string(), // base64, 16 bytes
    keyVersion: z.number().int().min(1).default(1),
    tokenExpiresAt: isoDate.nullish(),
    scopes: z.array(z.string()).default([]),
    status: channelStatus.default('active'),
    lastErrorCode: z.string().nullish(),
    lastErrorAt: isoDate.nullish(),
    subscribedFields: z.array(z.string()).default([]),
    connectedBy: objectIdString,
    version: z.number().int().min(0).default(0),
  })
  .strict()
export type ChannelConnectionDoc = z.infer<typeof ChannelConnectionDoc>

// ─── webhookEvents (D15) — the ONE optional-tenant collection ────────────────

export const webhookProcessStatus = z.enum([
  'pending',
  'processed',
  'failed',
  'orphaned',
  'invalid_signature',
])

export const WebhookEventDoc = z
  .object({
    provider: providerEnum,
    externalPageId: z.string().min(1),
    /** Optional — dedupe happens BEFORE tenant resolution (conflict DB-06). */
    workspaceId: objectIdString.nullish(),
    /** `{provider}:{pageId}:{mid}` — PLAINTEXT, never hashed (database.md §2.15). */
    dedupeKey: z.string().min(1),
    signatureValid: z.boolean(),
    rawPayload: z.record(z.unknown()),
    receivedAt: isoDate,
    processStatus: webhookProcessStatus.default('pending'),
    processedAt: isoDate.nullish(),
    attempts: z.number().int().min(0).default(0),
    lastError: z.string().nullish(),
    /** TTL 0 = receivedAt + 7d (OQ-11: do not extend). */
    expiresAt: isoDate,
  })
  .strict()
export type WebhookEventDoc = z.infer<typeof WebhookEventDoc>
