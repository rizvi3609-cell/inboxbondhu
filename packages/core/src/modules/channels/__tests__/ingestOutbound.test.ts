/**
 * Ingest + outbound tests: PSID→customer upsert (3-field key), conversation
 * denormalisation + metaWindowExpiresAt, billing counted ONCE, orphaned pages,
 * receipts, duplicate-mid replays, the 24 h outbound gate, permanent vs
 * retryable failures, and the OAuth/channel service (state, E11000, soft revoke).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChannelConnection, Conversation, Customer, Message, UsageLedger, WebhookEvent, Workspace, Membership, User,
  makeKeyring, encryptToken, processWebhookEvent, deliverOutboundMessage,
  ChannelsService, makeState, verifyStateSignature,
} from '../../../index.js'
import { makeTenantContext } from '../../../kernel/tenantContext.js'
import { createMockMetaClient } from '@inboxbondhu/integrations'
import { dropData, fakeUlid, oid, startDb, stopDb } from '../../../__tests__/setupDb.js'

const MASTER = Buffer.alloc(32, 7).toString('base64')
const keyring = makeKeyring(MASTER)
const DAY_MS = 86_400_000

beforeAll(async () => {
  await startDb()
}, 300_000)
afterAll(async () => {
  await stopDb()
})
beforeEach(async () => {
  await dropData()
})

async function seedWorkspaceWithChannel(pageId = '108888001') {
  const owner = await User.create({
    ulid: fakeUlid(), email: `o${Math.random().toString(36).slice(2)}@x.example`,
    passwordHash: 'h', name: 'Owner Person', emailVerifiedAt: new Date(),
  })
  const ws = await Workspace.create({
    name: 'Rupa Fashion', slug: `rupa-${Math.random().toString(36).slice(2, 8)}`, ownerId: owner._id,
    businessHours: { enabled: false, days: Array.from({ length: 7 }, (_, day) => ({ day, open: '09:00', close: '21:00', closed: false })) },
    aiConfig: {},
  })
  await Membership.create({ workspaceId: ws._id, userId: owner._id, role: 'owner', joinedAt: new Date() })
  const enc = encryptToken('EAAG-page-token', keyring)
  const channel = await ChannelConnection.create({
    workspaceId: ws._id, provider: 'facebook', externalPageId: pageId, pageName: 'Rupa Page',
    ...enc, scopes: ['pages_messaging'], subscribedFields: ['messages'], connectedBy: owner._id,
  })
  return { ws, channel, owner }
}

async function seedInboundEvent(pageId: string, mid: string, text = 'dam koto?', psid = 'psid-42') {
  await WebhookEvent.create({
    provider: 'facebook', externalPageId: pageId,
    dedupeKey: `facebook:${pageId}:${mid}`, signatureValid: true,
    rawPayload: { sender: { id: psid }, recipient: { id: pageId }, timestamp: Date.now(), message: { mid, text } },
    receivedAt: new Date(), processStatus: 'pending',
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
  })
  return `facebook:${pageId}:${mid}`
}

describe('webhook-ingest processing', () => {
  it('full happy path: customer upserted, conversation created, message inserted, window set, billing counted', async () => {
    const { ws } = await seedWorkspaceWithChannel()
    const key = await seedInboundEvent('108888001', 'mid.in1')

    const outcome = await processWebhookEvent(key)
    expect(outcome.status).toBe('processed')
    expect(outcome.enqueueAi).toBe(true) // mode ai, aiConfig defaults on

    const customer = await Customer.findOne({ workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-42' }).exec()
    expect(customer).not.toBeNull()

    const conv = await Conversation.findOne({ workspaceId: ws._id }).exec()
    expect(conv!.lastMessagePreview).toBe('dam koto?')
    expect(conv!.lastMessageDirection).toBe('inbound')
    expect(conv!.unreadCount).toBe(1)
    const windowMs = conv!.metaWindowExpiresAt!.getTime() - Date.now()
    expect(windowMs).toBeGreaterThan(23.9 * 3_600_000)
    expect(windowMs).toBeLessThanOrEqual(24 * 3_600_000)

    const msg = await Message.findOne({ workspaceId: ws._id, providerMessageId: 'mid.in1' }).exec()
    expect(msg!.direction).toBe('inbound')
    expect(msg!.author!.type).toBe('customer')

    const ledger = await UsageLedger.findOne({ workspaceId: ws._id }).exec()
    expect(ledger!.conversationsUsed).toBe(1)
    expect(ledger!.conversationsLimit).toBe(100) // trial snapshot

    const evt = await WebhookEvent.findOne({ dedupeKey: key }).exec()
    expect(evt!.processStatus).toBe('processed')
    expect(String(evt!.workspaceId)).toBe(String(ws._id))
  })

  it('billing counts a conversation exactly ONCE across many messages (countedForBilling)', async () => {
    const { ws } = await seedWorkspaceWithChannel()
    for (let i = 0; i < 3; i += 1) {
      const key = await seedInboundEvent('108888001', `mid.multi${i}`)
      await processWebhookEvent(key)
    }
    const ledger = await UsageLedger.findOne({ workspaceId: ws._id }).exec()
    expect(ledger!.conversationsUsed).toBe(1) // NOT 3
    expect(await Conversation.countDocuments({ workspaceId: ws._id }).exec()).toBe(1)
    expect(await Message.countDocuments({ workspaceId: ws._id }).exec()).toBe(3)
  })

  it('replayed job (same mid) is idempotent — exactly one message (INV-07)', async () => {
    await seedWorkspaceWithChannel()
    const key = await seedInboundEvent('108888001', 'mid.dup')
    await processWebhookEvent(key)
    // Re-run the same job (worker retry after crash): event already processed → skipped.
    const second = await processWebhookEvent(key)
    expect(second.status).toBe('skipped')
    // Even a fresh event carrying the same mid dedupes on I29.
    await WebhookEvent.deleteMany({ dedupeKey: key }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'retentionPurger' }).exec()
    const key2 = await seedInboundEvent('108888001', 'mid.dup')
    const third = await processWebhookEvent(key2)
    expect(third.status).toBe('duplicate')
    expect(await Message.countDocuments({ providerMessageId: 'mid.dup' }).setOptions({ skipTenancy: true, tenancyBypassCaller: 'adminReporting' }).exec()).toBe(1)
  })

  it('unknown page → orphaned, never rejected', async () => {
    const key = await seedInboundEvent('999-unknown-page', 'mid.orphan')
    const outcome = await processWebhookEvent(key)
    expect(outcome.status).toBe('orphaned')
    const evt = await WebhookEvent.findOne({ dedupeKey: key }).exec()
    expect(evt!.processStatus).toBe('orphaned')
    expect(evt!.workspaceId).toBeNull()
  })

  it('delivery + read receipts update deliveredAt/readAt', async () => {
    const { ws, channel } = await seedWorkspaceWithChannel()
    const customer = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-42', displayName: 'C',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    })
    const conv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: channel._id, customerId: customer._id,
      lastMessageAt: new Date(), metaWindowExpiresAt: new Date(Date.now() + DAY_MS),
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })
    await Message.create({
      workspaceId: ws._id, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'Ji, ache!',
      providerMessageId: 'mid.out9', status: 'sent', sentAt: new Date(),
    })
    await WebhookEvent.create({
      provider: 'facebook', externalPageId: '108888001',
      dedupeKey: 'facebook:108888001:delivery.108888001.42', signatureValid: true,
      rawPayload: { delivery: { mids: ['mid.out9'], watermark: Date.now() } },
      receivedAt: new Date(), processStatus: 'pending', expiresAt: new Date(Date.now() + 7 * DAY_MS),
    })
    const outcome = await processWebhookEvent('facebook:108888001:delivery.108888001.42')
    expect(outcome.status).toBe('receipt')
    const msg = await Message.findOne({ workspaceId: ws._id, providerMessageId: 'mid.out9' }).exec()
    expect(msg!.status).toBe('delivered')
    expect(msg!.deliveredAt).not.toBeNull()
  })

  it('media attachments produce media-fetch jobs and do not block processing', async () => {
    const { ws } = await seedWorkspaceWithChannel()
    await WebhookEvent.create({
      provider: 'facebook', externalPageId: '108888001',
      dedupeKey: 'facebook:108888001:mid.img', signatureValid: true,
      rawPayload: {
        sender: { id: 'psid-42' }, timestamp: Date.now(),
        message: { mid: 'mid.img', attachments: [{ type: 'image', payload: { url: 'https://cdn.fb/img.jpg' } }] },
      },
      receivedAt: new Date(), processStatus: 'pending', expiresAt: new Date(Date.now() + 7 * DAY_MS),
    })
    const outcome = await processWebhookEvent('facebook:108888001:mid.img')
    expect(outcome.status).toBe('processed')
    expect(outcome.mediaJobs).toEqual([{ attachmentUrl: 'https://cdn.fb/img.jpg', attachmentType: 'image' }])
    const msg = await Message.findOne({ workspaceId: ws._id, providerMessageId: 'mid.img' }).exec()
    expect(msg!.contentType).toBe('image')
  })
})

describe('outbound delivery — the 24 h gate', () => {
  async function seedOutbound(windowOffsetMs: number) {
    const pageId = `page-${Math.random().toString(36).slice(2, 10)}` // unique per call (I18 is global)
    const { ws, channel } = await seedWorkspaceWithChannel(pageId)
    const customer = await Customer.create({
      workspaceId: ws._id, provider: 'facebook', externalUserId: 'psid-42', displayName: 'C',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    })
    const conv = await Conversation.create({
      workspaceId: ws._id, channelConnectionId: channel._id, customerId: customer._id,
      lastMessageAt: new Date(), metaWindowExpiresAt: new Date(Date.now() + windowOffsetMs),
      purgeAfter: new Date(Date.now() + 90 * DAY_MS),
    })
    const msg = await Message.create({
      workspaceId: ws._id, conversationId: conv._id, direction: 'outbound',
      author: { type: 'agent', userId: oid() }, contentType: 'text', text: 'Ji, stock e ache!',
      status: 'queued',
    })
    return { ws, msg }
  }

  it('sends inside the window: decrypts the token, sets sent + providerMessageId', async () => {
    const { ws, msg } = await seedOutbound(DAY_MS)
    const { client, state } = createMockMetaClient()
    const result = await deliverOutboundMessage(String(msg._id), String(ws._id), client, keyring)
    expect(result.status).toBe('sent')
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0]!.pageToken).toBe('EAAG-page-token') // decrypted correctly
    expect(state.sent[0]!.recipient).toBe('psid-42')
    const fresh = await Message.findOne({ _id: msg._id, workspaceId: ws._id }).exec()
    expect(fresh!.status).toBe('sent')
    expect(fresh!.providerMessageId).toMatch(/^mid\.mock/)
  })

  it('REFUSES to send outside metaWindowExpiresAt (OQ-14: no HUMAN_AGENT bypass)', async () => {
    const { ws, msg } = await seedOutbound(-60_000) // expired a minute ago
    const { client, state } = createMockMetaClient()
    const result = await deliverOutboundMessage(String(msg._id), String(ws._id), client, keyring)
    expect(result.status).toBe('window_closed')
    expect(state.sent).toHaveLength(0) // Meta never called
    const fresh = await Message.findOne({ _id: msg._id, workspaceId: ws._id }).exec()
    expect(fresh!.status).toBe('failed')
    expect(fresh!.failureCode).toBe('WINDOW_EXPIRED')
  })

  it('4xx permanent failure → failed + failureCode; 5xx → retryable, message stays queued', async () => {
    const a = await seedOutbound(DAY_MS)
    const mock1 = createMockMetaClient()
    mock1.state.nextSendFailure = { permanent: true, code: 'USER_BLOCKED_PAGE' }
    const r1 = await deliverOutboundMessage(String(a.msg._id), String(a.ws._id), mock1.client, keyring)
    expect(r1.status).toBe('failed_permanent')
    expect((await Message.findOne({ _id: a.msg._id, workspaceId: a.ws._id }).exec())!.failureCode).toBe('USER_BLOCKED_PAGE')

    const b = await seedOutbound(DAY_MS)
    const mock2 = createMockMetaClient()
    mock2.state.nextSendFailure = { permanent: false, code: 'FB_5XX' }
    const r2 = await deliverOutboundMessage(String(b.msg._id), String(b.ws._id), mock2.client, keyring)
    expect(r2.status).toBe('failed_retryable')
    expect((await Message.findOne({ _id: b.msg._id, workspaceId: b.ws._id }).exec())!.status).toBe('queued') // BullMQ retries
  })

  it('replaying a sent message is a no-op (idempotent)', async () => {
    const { ws, msg } = await seedOutbound(DAY_MS)
    const { client, state } = createMockMetaClient()
    await deliverOutboundMessage(String(msg._id), String(ws._id), client, keyring)
    await deliverOutboundMessage(String(msg._id), String(ws._id), client, keyring)
    expect(state.sent).toHaveLength(1) // not sent twice
  })
})

describe('channels service — OAuth + soft disconnect', () => {
  function memoryStateStore() {
    const map = new Map<string, { workspaceId: string; userId: string }>()
    return {
      put: async (s: string, p: { workspaceId: string; userId: string }) => void map.set(s, p),
      take: async (s: string) => {
        const v = map.get(s) ?? null
        map.delete(s)
        return v
      },
    }
  }

  it('signed state verifies and a forged one fails', () => {
    const state = makeState('secret-1')
    expect(verifyStateSignature(state, 'secret-1')).toBe(true)
    expect(verifyStateSignature(state, 'other-secret')).toBe(false)
    expect(verifyStateSignature('nonsense', 'secret-1')).toBe(false)
  })

  it('completeOAuth: state mismatch → CSRF_TOKEN_INVALID; happy path encrypts + subscribes', async () => {
    const { ws, owner } = await seedWorkspaceWithChannel('some-other-page')
    const { client, state: metaState } = createMockMetaClient()
    const store = memoryStateStore()
    const svc = new ChannelsService(client, keyring, store, 'state-secret')
    const ctx = makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'owner', requestId: fakeUlid() })

    const bad = await svc.completeOAuth(ctx, 'forged.state', 'good-code', 'https://api/cb')
    expect(!bad.ok && bad.error.code).toBe('CSRF_TOKEN_INVALID')

    const started = await svc.startOAuth(ctx, 'app-id', 'https://api/cb')
    if (!started.ok) throw started.error
    const done = await svc.completeOAuth(ctx, started.value.state, 'good-code', 'https://api/cb')
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.value.pageName).toBe('Rupa Fashion BD')
    expect(metaState.subscribed).toContain('108888001')

    const row = await ChannelConnection.findOne({ workspaceId: ws._id, externalPageId: '108888001' }).exec()
    expect(row!.accessTokenCipher).not.toContain('EAAG') // encrypted at rest
    // State is single-use.
    const replay = await svc.completeOAuth(ctx, started.value.state, 'good-code', 'https://api/cb')
    expect(!replay.ok && replay.error.code).toBe('CSRF_TOKEN_INVALID')
  })

  it('a page owned by ANOTHER workspace → 409 "already connected" (ADR-013/I18)', async () => {
    await seedWorkspaceWithChannel('108888001') // workspace A holds the page
    const other = await seedWorkspaceWithChannel('unrelated-page') // workspace B
    const { client } = createMockMetaClient()
    const store = memoryStateStore()
    const svc = new ChannelsService(client, keyring, store, 'state-secret')
    const ctx = makeTenantContext({ workspaceId: String(other.ws._id), userId: String(other.owner._id), role: 'owner', requestId: fakeUlid() })
    const started = await svc.startOAuth(ctx, 'app-id', 'https://api/cb')
    if (!started.ok) throw started.error
    const res = await svc.completeOAuth(ctx, started.value.state, 'good-code', 'https://api/cb')
    expect(!res.ok && res.error.code).toBe('DUPLICATE_RESOURCE')
    if (!res.ok) expect(res.error.message).toMatch(/already connected to another workspace/)
  })

  it('disconnect is SOFT: status revoked, token fields zeroed, row retained', async () => {
    const { ws, channel, owner } = await seedWorkspaceWithChannel()
    const { client } = createMockMetaClient()
    const svc = new ChannelsService(client, keyring, memoryStateStore(), 's')
    const ctx = makeTenantContext({ workspaceId: String(ws._id), userId: String(owner._id), role: 'admin', requestId: fakeUlid() })

    const r = await svc.disconnect(ctx, String(channel._id))
    expect(r.ok).toBe(true)
    const row = await ChannelConnection.findOne({ _id: channel._id, workspaceId: ws._id }).exec()
    expect(row).not.toBeNull() // retained
    expect(row!.status).toBe('revoked')
    expect(row!.accessTokenCipher).toBe('') // zeroed
    // Foreign channel id → 404, never 403 (no existence leak).
    const foreign = await svc.disconnect(ctx, oid())
    expect(!foreign.ok && foreign.error.code).toBe('NOT_FOUND')
  })
})
