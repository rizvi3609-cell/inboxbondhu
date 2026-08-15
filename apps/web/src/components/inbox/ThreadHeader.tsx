'use client'

/**
 * Thread pane header (§6.2): customer identity, window chip, mode/status
 * badges (crossfade morph on change), Take Over / Return to AI / Resolve /
 * Reopen with OCC + the mid-capture 422 dialog.
 */
import { useState } from 'react'
import type { ConversationDetailView } from '@inboxbondhu/contracts'
import { api, ApiFailure } from '@/lib/api-client'
import { countdown, taka } from '@/lib/format'
import { AnimatePresence, m } from '@/lib/motion'
import { Avatar, Badge, Button } from '@/components/ui/primitives'
import { Dialog, useToast } from '@/components/ui/overlay'

export function ThreadHeader({ workspaceId, conv, onChanged }: {
  workspaceId: string
  conv: ConversationDetailView
  onChanged: () => void
}) {
  const { toast } = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [midCapture, setMidCapture] = useState(false)

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label)
    try {
      await api(`/api/v1/w/${workspaceId}/conversations/${conv.id}`, {
        method: 'PATCH', body, ifMatch: conv.version,
      })
      onChanged()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        toast('warn', 'This conversation changed under you — refreshed.')
        onChanged()
      } else if (err instanceof ApiFailure && err.status === 422) {
        setMidCapture(true) // §6.2: explain the mid-capture rule properly
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : `${label} failed.`)
      }
    } finally {
      setBusy(null)
    }
  }

  const wc = conv.metaWindowExpiresAt ? countdown(conv.metaWindowExpiresAt) : null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <Avatar name={conv.customer?.displayName ?? 'Customer'} id={conv.customer?.id ?? conv.id} provider="facebook" size={32} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{conv.customer?.displayName ?? 'Customer'}</div>
        {conv.customer && (conv.customer.orderCount > 0 || conv.customer.phone) && (
          <div className="muted" style={{ fontSize: 11 }}>
            {conv.customer.phone ?? ''}
            {conv.customer.orderCount > 0 && (
              <> · {conv.customer.orderCount} orders · {taka(conv.customer.totalSpentMinor)} lifetime</>
            )}
          </div>
        )}
      </div>

      {/* Mode badge morph (§4.2): crossfade+scale between AI and Human. */}
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={conv.mode}
          initial={{ opacity: 0, scale: 1.15 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: 0.2 }}
        >
          <Badge tone={conv.mode} breathing={conv.mode === 'ai'}>
            {conv.mode === 'ai' ? '🤖 AI handling' : '🙋 Human'}
          </Badge>
        </m.span>
      </AnimatePresence>
      <Badge tone={conv.status}>{conv.status}</Badge>
      {wc && (
        <Badge tone={wc.expired ? 'danger' : wc.urgent ? 'warn' : 'neutral'} title="Meta 24-hour messaging window">
          {wc.expired ? '⛔ Window closed' : `⏱ ${wc.text}`}
        </Badge>
      )}
      {conv.handoverReason && (
        <span className="muted" style={{ fontSize: 11 }}>handover: {conv.handoverReason}</span>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {conv.mode === 'ai' ? (
          <Button small loading={busy === 'take'} onClick={() => void patch({ mode: 'human' }, 'take')}>
            🙋 Take over
          </Button>
        ) : (
          <Button small loading={busy === 'return'} onClick={() => void patch({ mode: 'ai' }, 'return')}>
            🤖 Return to AI
          </Button>
        )}
        {conv.status !== 'resolved' ? (
          <Button small loading={busy === 'resolve'} onClick={() => void patch({ status: 'resolved' }, 'resolve')}>
            ✅ Resolve
          </Button>
        ) : (
          <Button small loading={busy === 'reopen'} onClick={() => void patch({ status: 'open' }, 'reopen')}>
            Reopen
          </Button>
        )}
      </div>

      <Dialog open={midCapture} onClose={() => setMidCapture(false)} title="An order is being captured">
        <p className="muted" style={{ marginTop: 0 }}>
          This conversation has a draft order mid-capture (Collecting or AwaitingConfirmation).
          Returning it to the AI now could double-collect details. Finish or cancel the draft
          order first, then return the conversation to the AI.
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" onClick={() => setMidCapture(false)}>Got it</Button>
        </div>
      </Dialog>
    </div>
  )
}
