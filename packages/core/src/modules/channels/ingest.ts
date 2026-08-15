/**
 * webhook-ingest processing (§9 Phase 3 item 4) — runs in the worker, AFTER
 * the 200 was already returned. Resolves tenant, upserts customer, finds/
 * creates conversation, inserts the message (I29 dedupe), updates the
 * denormalised conversation fields + metaWindowExpiresAt, counts billing
 * once, and reports whether conversation-ai should be enqueued.
 */
import mongoose from 'mongoose'
import {
  ChannelConnection, Conversation, Customer, Message, UsageLedger, WebhookEvent, Workspace,
} from '../../db/models/index.js'
import { PLAN_LIMITS } from '@inboxbondhu/contracts'
import { DhakaTime } from '../../kernel/dhakaTime.js'

const DAY_MS = 86_400_000

export interface IngestOutcome {
  status: 'processed' | 'orphaned' | 'duplicate' | 'receipt' | 'skipped'
  workspaceId?: string
  conversationId?: string
  messageId?: string
  enqueueAi: boolean
  mediaJobs: Array<{ attachmentUrl: string; attachmentType: string }>
}

interface MessagingEntry {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    attachments?: Array<{ type?: string; payload?: { url?: string } }>
  }
  postback?: { mid?: string; title?: string; payload?: string }
  delivery?: { mids?: string[]; watermark?: number }
  read?: { watermark?: number }
}

/**
 * P9.1 (audit H-1): realtime hint sink, injected by the caller — channels
 * never imports the notifications module (§5.1). Structural type on purpose.
 */
export type IngestNotify = (room: string, event: string, payload: Record<string, unknown>) => void

export async function processWebhookEvent(dedupeKey: string, notify?: IngestNotify): Promise<IngestOutcome> {
  const event = await WebhookEvent.findOne({ dedupeKey }).exec()
  if (!event || event.processStatus === 'processed') {
    return { status: 'skipped', enqueueAi: false, mediaJobs: [] }
  }

  // Resolve {provider, externalPageId} → workspace (I18). Unknown → orphaned + alert.
  const channel = await ChannelConnection.findOne({
    provider: event.provider, externalPageId: event.externalPageId, status: 'active',
  })
    .setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }) // pre-tenant routing (ADR-013)
    .exec()

  if (!channel) {
    await WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { processStatus: 'orphaned', processedAt: new Date() } },
    ).exec()
    return { status: 'orphaned', enqueueAi: false, mediaJobs: [] }
  }

  const workspaceId = channel.workspaceId as mongoose.Types.ObjectId
  const entry = event.rawPayload as MessagingEntry
  const now = new Date()

  // Receipts (§9 Phase 3 item 7): update deliveredAt/readAt, done.
  if (entry.delivery || entry.read) {
    if (entry.delivery?.mids?.length) {
      await Message.updateMany(
        { workspaceId, providerMessageId: { $in: entry.delivery.mids }, deliveredAt: null },
        { $set: { status: 'delivered', deliveredAt: now } },
      ).exec()
    } else if (entry.delivery?.watermark) {
      await Message.updateMany(
        { workspaceId, direction: 'outbound', status: 'sent', createdAt: { $lte: new Date(entry.delivery.watermark) } },
        { $set: { status: 'delivered', deliveredAt: now } },
      ).exec()
    }
    if (entry.read?.watermark) {
      await Message.updateMany(
        { workspaceId, direction: 'outbound', status: { $in: ['sent', 'delivered'] }, createdAt: { $lte: new Date(entry.read.watermark) } },
        { $set: { status: 'read', readAt: now } },
      ).exec()
    }
    await WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { workspaceId, processStatus: 'processed', processedAt: now } },
    ).exec()
    return { status: 'receipt', workspaceId: String(workspaceId), enqueueAi: false, mediaJobs: [] }
  }

  const psid = entry.sender?.id
  const mid = entry.message?.mid ?? entry.postback?.mid
  if (!psid || !mid) {
    await WebhookEvent.updateOne(
      { _id: event._id },
      { $set: { workspaceId, processStatus: 'processed', processedAt: now, lastError: 'no sender/mid' } },
    ).exec()
    return { status: 'skipped', workspaceId: String(workspaceId), enqueueAi: false, mediaJobs: [] }
  }

  // Upsert customer by the 3-field key (I21, DB-03).
  const customer = await Customer.findOneAndUpdate(
    { workspaceId, provider: event.provider, externalUserId: psid },
    {
      $setOnInsert: { displayName: `Customer ${psid.slice(-4)}`, firstSeenAt: now },
      $set: { lastSeenAt: now },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec()

  // Find-or-create conversation.
  let conversation = await Conversation.findOne({ workspaceId, customerId: customer._id }).exec()
  let isNewConversation = false
  if (!conversation) {
    conversation = await Conversation.create({
      workspaceId,
      channelConnectionId: channel._id,
      customerId: customer._id,
      lastMessageAt: now,
      purgeAfter: new Date(now.getTime() + 90 * DAY_MS),
    })
    isNewConversation = true
  }

  const text = entry.message?.text ?? entry.postback?.title ?? null
  const attachments = entry.message?.attachments ?? []
  const mediaJobs = attachments
    .filter((a) => a.payload?.url)
    .map((a) => ({ attachmentUrl: a.payload!.url!, attachmentType: a.type ?? 'file' }))

  // Insert the message — I29 unique makes retries idempotent (INV-07).
  let messageId: string
  try {
    const message = await Message.create({
      workspaceId,
      conversationId: conversation._id,
      direction: 'inbound',
      author: { type: 'customer' },
      contentType: entry.postback ? 'postback' : attachments.length > 0 ? (attachments[0]!.type as 'image') ?? 'file' : 'text',
      text,
      providerMessageId: mid,
      status: 'delivered',
    })
    messageId = String(message._id)
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      await WebhookEvent.updateOne(
        { _id: event._id },
        { $set: { workspaceId, processStatus: 'processed', processedAt: now } },
      ).exec()
      return { status: 'duplicate', workspaceId: String(workspaceId), enqueueAi: false, mediaJobs: [] }
    }
    throw err
  }

  // Denormalised conversation fields + the HARD 24 h compliance gate.
  await Conversation.updateOne(
    { _id: conversation._id, workspaceId },
    {
      $set: {
        lastMessageAt: now,
        lastMessagePreview: (text ?? `[${mediaJobs[0]?.attachmentType ?? 'attachment'}]`).slice(0, 140),
        lastMessageDirection: 'inbound',
        metaWindowExpiresAt: new Date(now.getTime() + 24 * 3_600_000),
        status: 'open',
        purgeAfter: new Date(now.getTime() + 90 * DAY_MS),
      },
      $inc: { unreadCount: 1, messageCount: 1 },
    },
  ).exec()

  // Billing: count each conversation ONCE per period (countedForBilling).
  const periodKey = DhakaTime.dhakaPeriodKey(now)
  if (isNewConversation || !conversation.countedForBilling) {
    const marked = await Conversation.updateOne(
      { _id: conversation._id, workspaceId, countedForBilling: false },
      { $set: { countedForBilling: true, billingPeriodKey: periodKey } },
    ).exec()
    if (marked.modifiedCount === 1) {
      const ws = await Workspace.findOne({ _id: workspaceId }).exec()
      // Hardcoding-audit fix: PLAN_LIMITS from contracts — was the 4th copy
      // of the tier numbers (channels may import the shared constant; the
      // §5.1 ban is on importing the plans MODULE).
      await UsageLedger.findOneAndUpdate(
        { workspaceId, periodKey },
        {
          $inc: { conversationsUsed: 1 },
          $setOnInsert: {
            plan: ws?.plan ?? 'trial',
            conversationsLimit: PLAN_LIMITS[ws?.plan ?? 'trial']?.conversations ?? PLAN_LIMITS.trial.conversations,
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec()
    }
  }

  await WebhookEvent.updateOne(
    { _id: event._id },
    { $set: { workspaceId, processStatus: 'processed', processedAt: now } },
  ).exec()

  // P9.1 (audit H-1): the realtime hint — IDs and a preview only (§12.3).
  // Best-effort by contract (§12.4); the DB write above is the truth.
  notify?.(`ws:${String(workspaceId)}`, 'message.created', {
    conversationId: String(conversation._id),
    messageId,
    preview: (text ?? '[attachment]').slice(0, 140),
    direction: 'inbound',
    at: now.toISOString(),
  })

  // AI eligibility — the actual enqueue is the worker's concern.
  const ws = await Workspace.findOne({ _id: workspaceId }).exec()
  const enqueueAi =
    conversation.mode === 'ai' &&
    (ws?.aiConfig?.enabled ?? false) &&
    (ws?.aiConfig?.autoReplyEnabled ?? false) &&
    !entry.postback

  return {
    status: 'processed',
    workspaceId: String(workspaceId),
    conversationId: String(conversation._id),
    messageId,
    enqueueAi,
    mediaJobs,
  }
}
