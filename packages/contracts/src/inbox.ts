import { z } from 'zod'
import { bdPhone, isoDate, moneyMinor, objectIdString, periodKey, providerEnum } from './common.js'

// ─── customers (D07) ─────────────────────────────────────────────────────────

export const CustomerDoc = z
  .object({
    workspaceId: objectIdString,
    provider: providerEnum,
    /** Unique with {workspaceId, provider} — the 3-field key (conflict DB-03). */
    externalUserId: z.string().min(1),
    displayName: z.string().min(1),
    profilePicUrl: z.string().nullish(), // expiring Meta CDN URL — never cached
    phone: bdPhone.nullish(), // PII — cleared at anonymisation
    phoneHash: z.string().length(64).nullish(), // SHA-256(phone+pepper) — SURVIVES anonymisation
    addressText: z.string().max(500).nullish(), // PII
    deliveryZone: z.string().nullish(),
    tags: z.array(z.string()).max(20).default([]),
    notes: z.string().max(2000).nullish(),
    orderCount: z.number().int().min(0).default(0),
    totalSpentMinor: moneyMinor.default(0),
    firstSeenAt: isoDate,
    lastSeenAt: isoDate,
    anonymizedAt: isoDate.nullish(),
  })
  .strict()
export type CustomerDoc = z.infer<typeof CustomerDoc>

// ─── conversations (D08) ─────────────────────────────────────────────────────

export const conversationStatus = z.enum(['open', 'pending', 'resolved'])
export const conversationMode = z.enum(['ai', 'human'])
// OPEN QUESTION: database.md §2.8 gives the handoverReason enum in prose only
// ("low confidence, keyword, explicit request, complaint, repeated failure").
// Implemented the narrow snake_case forms pending exact wire values.
export const handoverReason = z.enum([
  'low_confidence',
  'keyword',
  'explicit_request',
  'complaint',
  'repeated_failure',
])
export const messageDirection = z.enum(['inbound', 'outbound'])

export const ConversationDoc = z
  .object({
    workspaceId: objectIdString,
    channelConnectionId: objectIdString,
    customerId: objectIdString,
    status: conversationStatus.default('open'),
    mode: conversationMode.default('ai'),
    assignedTo: objectIdString.nullish(),
    assignedAt: isoDate.nullish(),
    handoverReason: handoverReason.nullish(),
    lastMessageAt: isoDate, // primary inbox sort key
    lastMessagePreview: z.string().max(140).nullish(), // denormalised on purpose
    lastMessageDirection: messageDirection.nullish(),
    unreadCount: z.number().int().min(0).default(0),
    messageCount: z.number().int().min(0).default(0),
    /** Hard compliance gate — outbound refuses to send outside it (OQ-14: no HUMAN_AGENT tag). */
    metaWindowExpiresAt: isoDate.nullish(),
    countedForBilling: z.boolean().default(false),
    billingPeriodKey: periodKey.nullish(),
    tags: z.array(z.string()).max(20).default([]),
    version: z.number().int().min(0).default(0),
    purgeAfter: isoDate, // lastMessageAt + 90d
  })
  .strict()
export type ConversationDoc = z.infer<typeof ConversationDoc>

// ─── messages (D09) — highest volume; NO version field (append-mostly) ───────

export const authorType = z.enum(['customer', 'ai', 'agent', 'system'])
export const contentType = z.enum(['text', 'image', 'audio', 'video', 'file', 'template', 'postback'])
export const messageStatus = z.enum(['queued', 'sent', 'delivered', 'read', 'failed'])

export const aiIntent = z.enum([
  'greeting',
  'product_search',
  'price_question',
  'availability_question',
  'delivery_question',
  'size_or_color_question',
  'order_start',
  'provide_customer_detail',
  'order_confirmation',
  'payment_question',
  'complaint',
  'human_request',
  'unknown',
])

export const attachment = z
  .object({
    type: z.string().min(1),
    /** Spaces key, NEVER a Meta CDN URL — Meta URLs expire. */
    spacesKey: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().min(0),
    width: z.number().int().min(0).nullish(),
    height: z.number().int().min(0).nullish(),
  })
  .strict()

export const MessageDoc = z
  .object({
    workspaceId: objectIdString,
    conversationId: objectIdString,
    direction: messageDirection,
    author: z
      .object({
        type: authorType,
        /** Required iff type === 'agent' — Mongoose custom validator enforces. */
        userId: objectIdString.nullish(),
      })
      .strict(),
    contentType,
    text: z.string().max(4000).nullish(),
    attachments: z.array(attachment).default([]),
    /** Meta MID — unique sparse with workspaceId (I29). THE dedupe key. */
    providerMessageId: z.string().nullish(),
    status: messageStatus.default('queued'),
    failureCode: z.string().nullish(),
    failureDetail: z.string().nullish(),
    sentAt: isoDate.nullish(),
    deliveredAt: isoDate.nullish(),
    readAt: isoDate.nullish(),
    aiMeta: z
      .object({
        intent: aiIntent.nullish(),
        confidence: z.number().min(0).max(1).nullish(),
        /** Auditable record of what the AI was ALLOWED to say — grounding proof. */
        sourceIds: z.array(objectIdString).default([]),
        model: z.string().nullish(),
        promptVersion: z.string().nullish(),
        latencyMs: z.number().int().min(0).nullish(),
        costMinor: moneyMinor.nullish(),
        groundingBlocked: z.boolean().nullish(),
        blockReason: z.string().nullish(),
      })
      .strict()
      .nullish(),
  })
  .strict()
export type MessageDoc = z.infer<typeof MessageDoc>
