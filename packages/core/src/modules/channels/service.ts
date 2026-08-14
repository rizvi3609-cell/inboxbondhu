/**
 * MOD-03 channels service — OAuth state, connect (encrypt + subscribe +
 * upsert), soft disconnect (ADR-013/DB-05: status revoked, tokens ZEROED,
 * row retained), reconnect, list.
 */
import { AppError } from '../../kernel/appError.js'
import { Result } from '../../kernel/result.js'
import type { TenantContext } from '../../kernel/tenantContext.js'
import { ChannelConnection, AuditLog } from '../../db/models/index.js'
import type { MetaClient } from '@inboxbondhu/integrations'
import { encryptToken, type Keyring } from './tokenCrypto.js'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export interface OAuthStateStore {
  /** SET state → {workspaceId,userId} EX 600. */
  put(state: string, payload: { workspaceId: string; userId: string }): Promise<void>
  /** GETDEL — single use. */
  take(state: string): Promise<{ workspaceId: string; userId: string } | null>
}

/** Signed state: `${random}.${hmac}` so a forged state fails even if Redis is poisoned. */
export function makeState(secret: string): string {
  const nonce = randomBytes(16).toString('hex')
  const mac = createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 32)
  return `${nonce}.${mac}`
}

export function verifyStateSignature(state: string, secret: string): boolean {
  const [nonce, mac] = state.split('.')
  if (!nonce || !mac) return false
  const expected = createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 32)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads']

export class ChannelsService {
  constructor(
    private readonly meta: MetaClient,
    private readonly keyring: Keyring,
    private readonly stateStore: OAuthStateStore,
    private readonly stateSecret: string,
  ) {}

  /** #36 — build the OAuth URL; unspecified failure mode → 502 (prompt.md §17). */
  async startOAuth(
    ctx: TenantContext,
    appId: string,
    redirectUri: string,
  ): Promise<Result<{ url: string; state: string }, AppError>> {
    try {
      const state = makeState(this.stateSecret)
      await this.stateStore.put(state, { workspaceId: ctx.workspaceId, userId: ctx.userId })
      const url =
        `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(appId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}` +
        `&scope=${encodeURIComponent('pages_messaging,pages_manage_metadata,pages_show_list')}`
      return Result.ok({ url, state })
    } catch {
      return Result.err(new AppError('UPSTREAM_FAILED', 'Could not start the Facebook connection.'))
    }
  }

  /** #37 — state mismatch → 403 CSRF_TOKEN_INVALID; duplicate page → 409. */
  async completeOAuth(
    ctx: TenantContext,
    state: string,
    code: string,
    redirectUri: string,
  ): Promise<Result<{ channelId: string; pageName: string }, AppError>> {
    if (!verifyStateSignature(state, this.stateSecret)) {
      return Result.err(new AppError('CSRF_TOKEN_INVALID', 'OAuth state is invalid.'))
    }
    const stored = await this.stateStore.take(state) // single use
    if (!stored || stored.workspaceId !== ctx.workspaceId || stored.userId !== ctx.userId) {
      return Result.err(new AppError('CSRF_TOKEN_INVALID', 'OAuth state is invalid.'))
    }

    let page
    try {
      page = await this.meta.exchangeCodeForPage(code, redirectUri)
    } catch {
      return Result.err(new AppError('UPSTREAM_FAILED', 'Facebook did not accept the connection code.'))
    }

    const encrypted = encryptToken(page.accessToken, this.keyring)

    try {
      // Reconnect-after-revoke in the SAME workspace is an update; a page held
      // by ANOTHER workspace hits I18's E11000 (ADR-013 — this IS the guard).
      const existing = await ChannelConnection.findOne({
        workspaceId: ctx.workspaceId, provider: 'facebook', externalPageId: page.pageId,
      }).exec()

      let channelId: string
      if (existing) {
        await ChannelConnection.updateOne(
          { _id: existing._id, workspaceId: ctx.workspaceId },
          {
            $set: {
              ...encrypted,
              pageName: page.pageName,
              scopes: page.scopes,
              status: 'active',
              lastErrorCode: null,
              lastErrorAt: null,
              subscribedFields: SUBSCRIBED_FIELDS,
              connectedBy: ctx.userId,
              tokenExpiresAt: null,
            },
          },
        ).exec()
        channelId = String(existing._id)
      } else {
        const created = await ChannelConnection.create({
          workspaceId: ctx.workspaceId,
          provider: 'facebook',
          externalPageId: page.pageId,
          pageName: page.pageName,
          ...encrypted,
          scopes: page.scopes,
          subscribedFields: SUBSCRIBED_FIELDS,
          connectedBy: ctx.userId,
        })
        channelId = String(created._id)
      }

      await this.meta.subscribePageWebhooks(page.pageId, page.accessToken, SUBSCRIBED_FIELDS)

      await AuditLog.create({
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorType: 'user',
        actorRole: ctx.role === 'system' ? null : ctx.role,
        action: 'channel.connected',
        resourceType: 'channelConnection',
        resourceId: channelId,
        after: { pageName: page.pageName, provider: 'facebook' }, // never the token
        requestId: ctx.requestId,
      })
      return Result.ok({ channelId, pageName: page.pageName })
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // US-008 AC-3 — the friendly text for I18.
        return Result.err(
          new AppError('DUPLICATE_RESOURCE', 'This Facebook Page is already connected to another workspace.'),
        )
      }
      throw err
    }
  }

  /** #38 — SOFT disconnect: status revoked, token fields zeroed, row retained. */
  async disconnect(ctx: TenantContext, channelId: string): Promise<Result<void, AppError>> {
    const channel = await ChannelConnection.findOne({
      _id: channelId, workspaceId: ctx.workspaceId,
    }).exec()
    if (!channel) return Result.err(new AppError('NOT_FOUND', 'Channel not found.')) // 404, never 403
    if (channel.status === 'revoked') {
      return Result.err(new AppError('INVALID_STATE_TRANSITION', 'Channel is already disconnected.'))
    }
    await ChannelConnection.updateOne(
      { _id: channelId, workspaceId: ctx.workspaceId },
      {
        $set: {
          status: 'revoked',
          accessTokenCipher: '', accessTokenIv: '', accessTokenTag: '', // zeroed
        },
      },
    ).exec()
    await AuditLog.create({
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      actorType: 'user',
      actorRole: ctx.role === 'system' ? null : ctx.role,
      action: 'channel.disconnected',
      resourceType: 'channelConnection',
      resourceId: channelId,
      requestId: ctx.requestId,
    })
    return Result.ok(undefined)
  }

  async list(ctx: TenantContext): Promise<
    Result<Array<{ id: string; provider: string; pageName: string; status: string; connectedAt: Date }>, AppError>
  > {
    const channels = await ChannelConnection.find({ workspaceId: ctx.workspaceId }).exec()
    return Result.ok(
      channels.map((c) => ({
        id: String(c._id),
        provider: c.provider,
        pageName: c.pageName,
        status: c.status,
        connectedAt: (c as unknown as { createdAt: Date }).createdAt,
        // token fields NEVER returned by any API
      })),
    )
  }
}
