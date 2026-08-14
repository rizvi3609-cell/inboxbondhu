/**
 * outbound-message delivery (§9 Phase 3 item 6):
 * decrypt token → Meta Send API → sent + providerMessageId.
 * REFUSES to send outside metaWindowExpiresAt (hard compliance gate; OQ-14:
 * the HUMAN_AGENT tag is NOT used). 4xx = permanent fail + notify; 5xx = retry.
 */
import { AppError } from '../../kernel/appError.js'
import { ChannelConnection, Conversation, Customer, Message } from '../../db/models/index.js'
import type { MetaClient } from '@inboxbondhu/integrations'
import { MetaSendError } from '@inboxbondhu/integrations'
import { decryptToken, type Keyring } from './tokenCrypto.js'

export interface OutboundResult {
  status: 'sent' | 'failed_permanent' | 'failed_retryable' | 'window_closed'
  providerMessageId?: string
  failureCode?: string
}

export async function deliverOutboundMessage(
  messageId: string,
  workspaceId: string,
  meta: MetaClient,
  keyring: Keyring,
  now: () => Date = () => new Date(),
): Promise<OutboundResult> {
  const message = await Message.findOne({ _id: messageId, workspaceId }).exec()
  if (!message) throw new AppError('NOT_FOUND', 'Message not found.')
  if (message.status !== 'queued') {
    return { status: 'sent', providerMessageId: message.providerMessageId ?? undefined } // idempotent replay
  }

  const conversation = await Conversation.findOne({ _id: message.conversationId, workspaceId }).exec()
  if (!conversation) throw new AppError('NOT_FOUND', 'Conversation not found.')

  // THE hard gate — outbound refuses to send outside the 24 h window.
  if (!conversation.metaWindowExpiresAt || conversation.metaWindowExpiresAt < now()) {
    await Message.updateOne(
      { _id: messageId, workspaceId },
      { $set: { status: 'failed', failureCode: 'WINDOW_EXPIRED', failureDetail: 'Meta 24h messaging window closed' } },
    ).exec()
    return { status: 'window_closed', failureCode: 'WINDOW_EXPIRED' }
  }

  const channel = await ChannelConnection.findOne({
    _id: conversation.channelConnectionId, workspaceId, status: 'active',
  }).exec()
  if (!channel || !channel.accessTokenCipher) {
    await Message.updateOne(
      { _id: messageId, workspaceId },
      { $set: { status: 'failed', failureCode: 'CHANNEL_INACTIVE', failureDetail: 'Channel disconnected or token revoked' } },
    ).exec()
    return { status: 'failed_permanent', failureCode: 'CHANNEL_INACTIVE' }
  }

  const customer = await Customer.findOne({ _id: conversation.customerId, workspaceId }).exec()
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found.')

  const pageToken = decryptToken(
    {
      accessTokenCipher: channel.accessTokenCipher,
      accessTokenIv: channel.accessTokenIv,
      accessTokenTag: channel.accessTokenTag,
      keyVersion: channel.keyVersion,
    },
    keyring,
  )

  try {
    const sent = await meta.sendMessage(pageToken, customer.externalUserId, message.text ?? '')
    const sentAt = now()
    await Message.updateOne(
      { _id: messageId, workspaceId, status: 'queued' }, // single-doc $set, no OCC (gotcha #9)
      { $set: { status: 'sent', sentAt, providerMessageId: sent.providerMessageId } },
    ).exec()
    await Conversation.updateOne(
      { _id: conversation._id, workspaceId },
      {
        $set: {
          lastMessageAt: sentAt,
          lastMessagePreview: (message.text ?? '').slice(0, 140),
          lastMessageDirection: 'outbound',
        },
        $inc: { messageCount: 1 },
      },
    ).exec()
    return { status: 'sent', providerMessageId: sent.providerMessageId }
  } catch (err) {
    if (err instanceof MetaSendError && err.permanent) {
      // 4xx (e.g. user blocked the page): fail permanently, surface to agent.
      await Message.updateOne(
        { _id: messageId, workspaceId },
        { $set: { status: 'failed', failureCode: err.code, failureDetail: err.message } },
      ).exec()
      return { status: 'failed_permanent', failureCode: err.code }
    }
    // 5xx / network: leave queued — BullMQ retries per the §13.1 table.
    return { status: 'failed_retryable', failureCode: err instanceof MetaSendError ? err.code : 'NETWORK' }
  }
}
