'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure, newIdempotencyKey } from '@/lib/api-client'
import type { ConversationDetailView, MessageView } from '@inboxbondhu/contracts'
import { useRealtime } from '@/lib/realtime-context'

// The contracts view IS the detail shape (C-11) — no local extension.
type ConversationDetail = ConversationDetailView

export default function ConversationPage() {
  const { workspaceId, conversationId } = useParams<{ workspaceId: string; conversationId: string }>()
  const { subscribe } = useRealtime()
  const [conv, setConv] = useState<ConversationDetail | null>(null)
  const [messages, setMessages] = useState<MessageView[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const [c, m] = await Promise.all([
      api<ConversationDetail>(`/api/v1/w/${workspaceId}/conversations/${conversationId}`),
      api<{ messages: MessageView[] }>(`/api/v1/w/${workspaceId}/conversations/${conversationId}/messages?limit=100`),
    ])
    setConv(c)
    setMessages(m.messages)
  }, [workspaceId, conversationId])

  useEffect(() => {
    void load().catch((err) => setError(err instanceof ApiFailure ? err.error.message : 'Load failed.'))
  }, [load])

  useEffect(
    () =>
      subscribe((event, payload) => {
        if (event !== 'message.created' && event !== 'conversation.updated') return
        const p = payload as { conversationId: string }
        if (p.conversationId === conversationId) void load().catch(() => undefined)
      }),
    [subscribe, conversationId, load],
  )

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      // #44 — Idempotency-Key REQUIRED; a human reply forces mode:human.
      await api(`/api/v1/w/${workspaceId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: { text: text.trim() },
        idempotencyKey: newIdempotencyKey(),
      })
      setText('')
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.error.code === 'BUSINESS_RULE_VIOLATION') {
        setError('Cannot send: the 24-hour Meta messaging window has closed. The customer must message first.')
      } else {
        setError(err instanceof ApiFailure ? err.error.message : 'Send failed.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function patch(body: Record<string, unknown>) {
    if (!conv) return
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/conversations/${conversationId}`, {
        method: 'PATCH',
        body,
        ifMatch: conv.version,
      })
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        setError('Someone else changed this conversation — reloaded the latest state.')
        await load()
      } else {
        setError(err instanceof ApiFailure ? err.error.message : 'Update failed.')
      }
    }
  }

  async function retry(messageId: string) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/messages/${messageId}/retry`, { method: 'POST' })
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Retry failed.')
    }
  }

  if (!conv) return <p className="muted">Loading conversation…</p>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ margin: 0 }}>{conv.customer?.displayName ?? 'Customer'}</h2>
        <span className={`badge ${conv.mode}`}>{conv.mode === 'ai' ? 'AI handling' : 'Human'}</span>
        <span className={`badge ${conv.status}`}>{conv.status}</span>
        {conv.handoverReason && <span className="muted">handover: {conv.handoverReason}</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {conv.mode === 'ai' ? (
            <button onClick={() => void patch({ mode: 'human' })}>Take over</button>
          ) : (
            <button onClick={() => void patch({ mode: 'ai' })}>Return to AI</button>
          )}
          {conv.status !== 'resolved' ? (
            <button onClick={() => void patch({ status: 'resolved' })}>Resolve</button>
          ) : (
            <button onClick={() => void patch({ status: 'open' })}>Reopen</button>
          )}
        </div>
      </div>

      {conv.openOrder && (
        <div className="card" style={{ margin: '10px 0', background: '#f0fdfa' }}>
          Open order <strong>{conv.openOrder.orderCode ?? '(draft)'}</strong> — ৳{(conv.openOrder.totalMinor / 100).toLocaleString('en-IN')}{' '}
          · <a href={`/w/${workspaceId}/orders`}>view orders</a>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 4px', display: 'grid', gap: 8, alignContent: 'start' }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              justifySelf: m.direction === 'inbound' ? 'start' : 'end',
              maxWidth: '70%',
              background: m.direction === 'inbound' ? 'var(--panel)' : m.author.type === 'ai' ? '#ede9fe' : 'var(--brand-soft)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '8px 12px',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
              {m.direction === 'inbound' ? 'Customer' : m.author.type === 'ai' ? 'AI' : 'Agent'} ·{' '}
              {new Date(m.createdAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })}
              {m.status === 'failed' && (
                <>
                  {' '}· <span className="error-text">failed{m.failureCode ? ` (${m.failureCode})` : ''}</span>{' '}
                  {m.failureCode !== 'WINDOW_EXPIRED' && (
                    <button style={{ padding: '0 6px', fontSize: 11 }} onClick={() => void retry(m.id)}>retry</button>
                  )}
                </>
              )}
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{m.text ?? <span className="muted">[{m.contentType}]</span>}</div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="error-text">{error}</p>}
      <form onSubmit={send} style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reply in Banglish… (sending as human takes the conversation over)"
          maxLength={4000}
        />
        <button className="primary" disabled={busy || !text.trim()} type="submit">
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
