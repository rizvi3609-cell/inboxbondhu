'use client'

/**
 * F2 — the thread pane (FRONTEND-SPEC §6.2, user-story Act 6/8).
 *  - window countdown chip (metaWindowExpiresAt; red < 1 h; P-01 explained
 *    BEFORE a send fails)
 *  - bubbles: customer left / AI violet / agent teal; failed = outline +
 *    reason (+ retry, hidden for WINDOW_EXPIRED per P-01)
 *  - optimistic reply in the REAL `queued` state (no lie — spec §5.2.6)
 *  - auto-scroll only at bottom; else the "↓ new message" pill
 *  - Take Over ↔ Return to AI morph; 422 mid-capture dialog copy
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ConversationDetailView, MessageView, RtMessageCreated } from '@inboxbondhu/contracts'
import { api, ApiFailure, newIdempotencyKey } from '@/lib/api-client'
import { countdown, dhakaTime, taka } from '@/lib/format'
import { AnimatePresence, m, bubbleEnter } from '@/lib/motion'
import { useRealtime } from '@/lib/realtime-context'
import { Badge, Button, Skeleton, TypingDots } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'

// The window countdown chip lives in ThreadHeader — ONE source (§6.2).

function bubbleStyle(msg: MessageView): React.CSSProperties {
  const isInbound = msg.direction === 'inbound'
  const isAi = msg.author.type === 'ai'
  return {
    justifySelf: isInbound ? 'start' : 'end',
    maxWidth: 'min(70%, 520px)',
    background: isInbound ? 'var(--panel)' : isAi ? 'var(--ai-soft)' : 'var(--brand-soft)',
    border: msg.status === 'failed' ? '1px solid var(--danger)' : '1px solid var(--border)',
    borderRadius: isInbound ? '4px 14px 14px 14px' : '14px 4px 14px 14px',
    padding: '8px 12px',
    boxShadow: 'var(--shadow-1)',
  }
}

const STATUS_TICK: Record<string, string> = {
  queued: '🕐', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '✕',
}

export function Thread({ workspaceId, conversationId, refreshSignal = 0, onConversationChange }: {
  workspaceId: string
  conversationId: string
  /** Bump to reload data WITHOUT remounting (scroll position survives). */
  refreshSignal?: number
  /** Bubbles list-visible state up (mode/status badges in the pane header). */
  onConversationChange?: (conv: ConversationDetailView) => void
}) {
  const { subscribe } = useRealtime()
  const { toast } = useToast()
  const [conv, setConv] = useState<ConversationDetailView | null>(null)
  const [messages, setMessages] = useState<MessageView[] | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiThinking, setAiThinking] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  const load = useCallback(async () => {
    const [c, msgs] = await Promise.all([
      api<ConversationDetailView>(`/api/v1/w/${workspaceId}/conversations/${conversationId}`),
      api<{ messages: MessageView[] }>(`/api/v1/w/${workspaceId}/conversations/${conversationId}/messages?limit=100`),
    ])
    setConv(c)
    onConversationChange?.(c)
    setMessages(msgs.messages)
  }, [workspaceId, conversationId, onConversationChange])

  useEffect(() => {
    setConv(null)
    setMessages(null)
    void load().catch(() => setMessages([]))
  }, [load])

  // Header actions (take-over/resolve) → soft reload, scroll intact.
  useEffect(() => {
    if (refreshSignal > 0) void load().catch(() => undefined)
  }, [refreshSignal, load])

  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event !== 'message.created' && event !== 'conversation.updated') return
        const p = payload as { conversationId: string }
        if (p.conversationId !== conversationId) return
        if (event === 'message.created') {
          const mp = payload as RtMessageCreated
          // Customer message while AI is on → show the thinking dots until
          // the AI's outbound lands (or the pipeline hands over).
          if (mp.direction === 'inbound' && conv?.mode === 'ai') setAiThinking(true)
          else setAiThinking(false)
        }
        void load().catch(() => undefined)
      }),
    [subscribe, conversationId, load, conv?.mode],
  )

  // §4.2 auto-scroll: only when the user is at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || messages === null) return
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      setNewBelow(false)
    } else {
      setNewBelow(true)
    }
  }, [messages])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottomRef.current) setNewBelow(false)
  }

  const windowClosed = conv?.metaWindowExpiresAt ? countdown(conv.metaWindowExpiresAt).expired : false

  async function send(e: FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body || !conv) return
    setBusy(true)
    setText('')

    // Optimistic bubble in the REAL lifecycle state `queued` (§5.2.6) —
    // reconciled (replaced by the server row) on the next load().
    const optimisticId = `optimistic-${Date.now()}`
    setMessages((prev) => [
      ...(prev ?? []),
      {
        id: optimisticId, direction: 'outbound',
        author: { type: 'agent', userId: null }, contentType: 'text',
        text: body, attachments: null, status: 'queued', failureCode: null,
        sentAt: null, deliveredAt: null, readAt: null, createdAt: new Date().toISOString(),
      },
    ])
    atBottomRef.current = true

    try {
      await api(`/api/v1/w/${workspaceId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { text: body },
        idempotencyKey: newIdempotencyKey(), // C-7
      })
      await load()
    } catch (err) {
      setMessages((prev) => (prev ?? []).filter((msg) => msg.id !== optimisticId)) // revert
      setText(body) // give them their words back
      if (err instanceof ApiFailure && err.error.code === 'BUSINESS_RULE_VIOLATION') {
        toast('warn', 'The 24-hour Meta window has closed — the customer must message first (P-01).')
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Send failed.', err instanceof ApiFailure ? err.error.requestId : undefined)
      }
    } finally {
      setBusy(false)
    }
  }

  async function retry(messageId: string) {
    try {
      await api(`/api/v1/w/${workspaceId}/messages/${messageId}/retry`, { method: 'POST' })
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Retry failed.')
    }
  }

  if (messages === null) {
    return (
      <div style={{ display: 'grid', gap: 10, padding: 16, alignContent: 'start' }}>
        <Skeleton width="40%" height={20} />
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} width={i % 2 ? '55%' : '45%'} height={44} radius={14}
            style={{ justifySelf: i % 2 ? 'end' : 'start' }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {/* Open-order card (§6.2) — sticky above the composer area */}
      {conv?.openOrder && (
        <m.div {...bubbleEnter} style={{
          margin: '0 0 8px', padding: '8px 12px', borderRadius: 'var(--radius-sm)',
          background: 'var(--ok-soft)', border: '1px solid var(--ok)',
          display: 'flex', gap: 8, alignItems: 'center', fontSize: 12,
        }}>
          📦 Open order <strong>{conv.openOrder.orderCode ?? '(draft)'}</strong>
          <Badge tone={conv.openOrder.fulfillmentStatus}>{conv.openOrder.fulfillmentStatus}</Badge>
          <span className="mono-num" style={{ marginLeft: 'auto', fontWeight: 700 }}>{taka(conv.openOrder.totalMinor)}</span>
        </m.div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'grid', gap: 8, alignContent: 'start', padding: '4px 2px' }}
      >
        <AnimatePresence initial={false}>
          {messages.map(
            (msg) => (
              <m.div key={msg.id} {...bubbleEnter} style={bubbleStyle(msg)}>
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginBottom: 3, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontWeight: 650 }}>
                    {msg.direction === 'inbound' ? conv?.customer?.displayName ?? 'Customer' : msg.author.type === 'ai' ? '🤖 AI' : 'Agent'}
                  </span>
                  <span className="mono-num">{dhakaTime(msg.createdAt)}</span>
                  {msg.direction === 'outbound' && (
                    <span className="mono-num" title={msg.status} style={{ color: msg.status === 'read' ? 'var(--brand)' : undefined }}>
                      {STATUS_TICK[msg.status] ?? ''}
                    </span>
                  )}
                </div>
                <div className="bn" style={{ whiteSpace: 'pre-wrap', fontSize: 13, wordBreak: 'break-word' }}>
                  {msg.text ?? <span className="muted">[{msg.contentType}]{/* C-14 media fallback lands with real media in F3+ */}</span>}
                </div>
                {msg.status === 'failed' && (
                  <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="error-text">failed{msg.failureCode ? ` — ${msg.failureCode}` : ''}</span>
                    {msg.failureCode !== 'WINDOW_EXPIRED' && ( /* P-01: retries will never succeed */
                      <Button small onClick={() => void retry(msg.id)}>Retry</Button>
                    )}
                  </div>
                )}
              </m.div>
            ),
          )}
          {aiThinking && (
            <m.div key="ai-thinking" {...bubbleEnter} style={{
              justifySelf: 'end', background: 'var(--ai-soft)', border: '1px solid var(--border)',
              borderRadius: '14px 4px 14px 14px', padding: '10px 14px',
            }}>
              <TypingDots />
            </m.div>
          )}
        </AnimatePresence>
      </div>

      {/* §4.2 "↓ new message" pill when scrolled up */}
      <AnimatePresence>
        {newBelow && (
          <m.button
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            onClick={() => {
              const el = scrollRef.current
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            }}
            style={{
              position: 'absolute', bottom: 74, left: '50%', transform: 'translateX(-50%)',
              font: 'inherit', fontSize: 12, fontWeight: 650, cursor: 'pointer',
              background: 'var(--brand)', color: '#fff', border: 'none',
              borderRadius: 999, padding: '5px 14px', boxShadow: 'var(--shadow-2)',
            }}
          >
            ↓ New message
          </m.button>
        )}
      </AnimatePresence>

      <form onSubmit={send} style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="bn"
          disabled={windowClosed}
          maxLength={4000}
          aria-label="Reply"
          placeholder={windowClosed
            ? 'Window closed — the customer must message first (Meta policy)'
            : conv?.mode === 'ai' ? 'Reply as human (takes over from the AI)…' : 'Type a reply…'}
          style={{
            // §4.2: composer border mirrors the mode — violet while AI owns it.
            borderColor: conv?.mode === 'ai' ? 'var(--ai)' : 'var(--brand)',
            transition: 'border-color var(--dur-base) ease',
          }}
        />
        <Button variant="primary" type="submit" loading={busy} disabled={windowClosed || !text.trim()}>
          Send
        </Button>
      </form>
    </div>
  )
}
