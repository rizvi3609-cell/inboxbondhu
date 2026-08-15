'use client'

/**
 * F4 — Settings → Channels (§6.7, user-story Act 3 + Act 9): connection
 * cards with page name/ID/status/connectedAt, the Act 9 expiry/reconnect
 * banner, connect CTA → Meta OAuth, disconnect with confirm, 502 explained
 * when Meta credentials are absent (OQ interim behaviour).
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import type { ChannelView } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { dhakaDate } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { Badge, Button, EmptyState, SkeletonRow } from '@/components/ui/primitives'
import { Dialog, useToast } from '@/components/ui/overlay'

export default function ChannelsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [channels, setChannels] = useState<ChannelView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [disconnectTarget, setDisconnectTarget] = useState<ChannelView | null>(null)

  const load = useCallback(async () => {
    // #35 — the one bare-array list (audit H-2).
    const data = await api<ChannelView[]>(`/api/v1/w/${workspaceId}/channels`)
    setChannels(data)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => setChannels([]))
  }, [load])

  async function connect() {
    setBusy('connect')
    try {
      const { url } = await api<{ url: string }>(`/api/v1/w/${workspaceId}/channels/oauth/start`)
      window.location.href = url // → Meta OAuth (Act 3)
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 502) {
        toast('warn', 'Meta OAuth is not configured on this deployment yet (app credentials missing). The flow activates the moment credentials are set.')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Could not start the connect flow.')
      }
      setBusy(null)
    }
  }

  async function reconnect(ch: ChannelView) {
    setBusy(ch.id)
    try {
      const { url } = await api<{ url: string }>(`/api/v1/w/${workspaceId}/channels/${ch.id}/reconnect`, {
        method: 'POST', body: {},
      })
      window.location.href = url
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 502) {
        toast('warn', 'Meta OAuth is not configured on this deployment yet.')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Reconnect failed.')
      }
      setBusy(null)
    }
  }

  async function doDisconnect() {
    if (!disconnectTarget) return
    setBusy(disconnectTarget.id)
    try {
      await api(`/api/v1/w/${workspaceId}/channels/${disconnectTarget.id}`, { method: 'DELETE' })
      toast('success', `${disconnectTarget.pageName} disconnected — its messages stop flowing in.`)
      setDisconnectTarget(null)
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Disconnect failed.')
    } finally {
      setBusy(null)
    }
  }

  const expiring = channels?.find((c) => c.status === 'expired' || c.status === 'expiring') ?? null

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {/* Act 9: the expiry banner, verbatim CTA */}
      <AnimatePresence>
        {expiring && (
          <m.div {...rowEnter} style={{
            background: 'var(--warn-soft)', border: '1px solid var(--warn)',
            borderRadius: 'var(--radius-md)', padding: '12px 16px',
            display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div style={{ flex: 1, minWidth: 220 }}>
              <strong>Your Facebook Page connection has expired.</strong>
              <div className="muted" style={{ fontSize: 12 }}>
                Messages from <strong>{expiring.pageName}</strong> are not flowing in until you reconnect.
              </div>
            </div>
            <Button variant="primary" loading={busy === expiring.id} onClick={() => void reconnect(expiring)}>
              Reconnect Facebook Page
            </Button>
          </m.div>
        )}
      </AnimatePresence>

      {channels === null ? (
        <><SkeletonRow /><SkeletonRow /></>
      ) : channels.length === 0 ? (
        <EmptyState
          icon="🔗"
          title="No Page connected"
          hint="Connect your Facebook Page — customer DMs start appearing in the inbox within seconds of connecting."
          action={<Button variant="primary" loading={busy === 'connect'} onClick={() => void connect()}>Connect a Facebook Page</Button>}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gap: 8 }}>
            <AnimatePresence initial={false}>
              {channels.map((ch) => (
                <m.div key={ch.id} {...rowEnter} style={{
                  background: 'var(--panel)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '14px 16px',
                  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                }}>
                  <span style={{
                    width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center',
                    background: ch.provider === 'facebook' ? '#1877f2' : '#e1306c', color: '#fff', fontWeight: 800,
                  }}>
                    {ch.provider === 'facebook' ? 'f' : 'ig'}
                  </span>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <strong>{ch.pageName}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {ch.provider} · connected {dhakaDate(ch.connectedAt)}
                    </div>
                  </div>
                  <Badge tone={ch.status === 'active' ? 'ok' : ch.status}>{ch.status}</Badge>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {ch.status !== 'active' && (
                      <Button small variant="primary" loading={busy === ch.id} onClick={() => void reconnect(ch)}>
                        Reconnect
                      </Button>
                    )}
                    <Button small variant="danger" onClick={() => setDisconnectTarget(ch)}>Disconnect</Button>
                  </div>
                </m.div>
              ))}
            </AnimatePresence>
          </div>
          <div>
            <Button loading={busy === 'connect'} onClick={() => void connect()}>+ Connect another Page</Button>
          </div>
        </>
      )}

      <Dialog
        open={disconnectTarget !== null}
        onClose={() => setDisconnectTarget(null)}
        title={`Disconnect ${disconnectTarget?.pageName}?`}
      >
        <p className="muted" style={{ marginTop: 0 }}>
          New messages from this Page stop arriving immediately. Existing conversations and history stay.
          The stored access token is destroyed (you can reconnect any time).
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={() => setDisconnectTarget(null)}>Keep connected</Button>
          <Button variant="danger" loading={busy === disconnectTarget?.id} onClick={() => void doDisconnect()}>
            Disconnect
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
