'use client'

/**
 * F3 — Knowledge (FRONTEND-SPEC §6.5): draft→approved flow with the "AI can
 * only say approved things" framing, approve ✓ draw-in, edit dialog that
 * warns about the draft-revert rule (US-014), and the C-6 ConflictDialog in
 * REAL use — 409 → per-field diff → Reapply/Keep-theirs.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'next/navigation'
import type { KnowledgeItemView } from '@inboxbondhu/contracts'
import { api, ApiFailure } from '@/lib/api-client'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { Badge, Button, CheckDraw, EmptyState, Tabs } from '@/components/ui/primitives'
import { ConflictDialog, Dialog, useToast, type ConflictInfo } from '@/components/ui/overlay'

type StatusFilter = 'all' | 'draft' | 'approved' | 'archived'

export default function KnowledgePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [rows, setRows] = useState<KnowledgeItemView[] | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [justApproved, setJustApproved] = useState<string | null>(null)
  const [editing, setEditing] = useState<KnowledgeItemView | null>(null)
  const [editQ, setEditQ] = useState('')
  const [editA, setEditA] = useState('')
  const [conflict, setConflict] = useState<{ info: ConflictInfo; retry: () => void } | null>(null)

  const load = useCallback(async () => {
    const data = await api<{ items: KnowledgeItemView[] }>(`/api/v1/w/${workspaceId}/knowledge`)
    setRows(data.items)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => setRows([]))
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy('create')
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge`, { method: 'POST', body: { question, answer } })
      setQuestion('')
      setAnswer('')
      toast('success', 'Added as draft — approve it to let the AI use it.')
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Create failed.')
    } finally {
      setBusy(null)
    }
  }

  async function approve(item: KnowledgeItemView) {
    setBusy(item.id)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge/${item.id}/approve`, { method: 'POST', ifMatch: item.version })
      setJustApproved(item.id) // §4.2 ✓ draw-in
      setTimeout(() => setJustApproved(null), 1_600)
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        toast('warn', 'This FAQ changed under you — refreshed.')
        await load()
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Approve failed.')
      }
    } finally {
      setBusy(null)
    }
  }

  async function remove(item: KnowledgeItemView) {
    setBusy(item.id)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge/${item.id}`, { method: 'DELETE', ifMatch: item.version })
      toast('success', 'Archived — the AI stops citing it immediately.')
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Archive failed.')
    } finally {
      setBusy(null)
    }
  }

  function openEdit(item: KnowledgeItemView) {
    setEditing(item)
    setEditQ(item.question)
    setEditA(item.answer)
  }

  /** The C-6 flow in anger: PATCH → 409 → diff dialog → reapply with the
   *  FRESH version, or keep theirs. Never a silent retry. */
  const saveEdit = useCallback(async (item: KnowledgeItemView, q: string, a: string) => {
    setBusy(item.id)
    try {
      await api(`/api/v1/w/${workspaceId}/knowledge/${item.id}`, {
        method: 'PATCH', body: { question: q, answer: a }, ifMatch: item.version,
      })
      toast('success', item.status === 'approved'
        ? 'Saved — this FAQ is back to draft until re-approved (US-014).'
        : 'Saved.')
      setEditing(null)
      await load()
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) {
        // Refetch theirs, build the field diff, offer reapply-with-fresh-version.
        const fresh = await api<{ items: KnowledgeItemView[] }>(`/api/v1/w/${workspaceId}/knowledge`)
        const theirs = fresh.items.find((k) => k.id === item.id)
        if (!theirs) {
          toast('error', 'This FAQ was deleted by someone else.')
          setEditing(null)
          await load()
          return
        }
        const fields = (err.error.conflictingFields?.length ? err.error.conflictingFields : ['question', 'answer'])
          .filter((f) => f === 'question' || f === 'answer')
        setConflict({
          info: {
            conflictingFields: fields,
            mine: { question: q, answer: a },
            theirs: { question: theirs.question, answer: theirs.answer },
          },
          retry: () => void saveEdit(theirs, q, a), // reapply on the CURRENT version
        })
      } else {
        toast('error', err instanceof ApiFailure ? err.error.message : 'Save failed.')
      }
    } finally {
      setBusy(null)
    }
  }, [workspaceId, toast, load])

  const visible = rows?.filter((k) => filter === 'all' || k.status === filter) ?? null

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>Knowledge base</h1>
        <div style={{ marginLeft: 'auto' }}>
          <Tabs
            tabs={[
              { id: 'all' as const, label: 'All' },
              { id: 'draft' as const, label: 'Drafts', count: rows?.filter((k) => k.status === 'draft').length ?? 0 },
              { id: 'approved' as const, label: 'Approved' },
              { id: 'archived' as const, label: 'Archived' },
            ]}
            active={filter}
            onChange={setFilter}
          />
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0, marginBottom: 16 }}>
        The AI answers <strong>only</strong> from approved FAQs and your catalogue — a draft is invisible to it.
        Approving is a deliberate act.
      </p>

      <form onSubmit={create} style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 16, display: 'grid', gap: 10, marginBottom: 16,
      }}>
        <label>
          Question — as customers actually ask it
          <input className="bn" value={question} onChange={(e) => setQuestion(e.target.value)}
            required minLength={5} maxLength={500} placeholder="Delivery charge koto?" />
        </label>
        <label>
          Answer — exactly what the AI may say
          <textarea className="bn" value={answer} onChange={(e) => setAnswer(e.target.value)}
            required minLength={5} maxLength={2000} rows={3}
            placeholder="Dhaka city te 60 taka, Dhakar baire 120 taka." />
        </label>
        <div>
          <Button variant="primary" type="submit" loading={busy === 'create'}>Add as draft</Button>
        </div>
      </form>

      {visible === null ? null : visible.length === 0 ? (
        <EmptyState
          icon="📖"
          title={filter === 'all' ? 'No FAQs yet' : `No ${filter} FAQs`}
          hint="Start with delivery charges, sizes, and the return policy — the questions customers repeat all day."
        />
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          <AnimatePresence initial={false}>
            {visible.map((k) => (
              <m.div key={k.id} layout="position" {...rowEnter} style={{
                background: 'var(--panel)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)', padding: '12px 14px',
                display: 'flex', gap: 12, alignItems: 'flex-start',
                opacity: k.status === 'archived' ? 0.65 : 1,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong className="bn">{k.question}</strong>
                    <Badge tone={k.status}>{k.status}</Badge>
                    {justApproved === k.id && <CheckDraw size={16} />}
                  </div>
                  <p className="bn muted" style={{ margin: '4px 0 0', fontSize: 12 }}>{k.answer}</p>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {k.status === 'draft' && (
                    <Button small variant="primary" loading={busy === k.id} onClick={() => void approve(k)}>
                      Approve
                    </Button>
                  )}
                  {k.status !== 'archived' && (
                    <>
                      <Button small onClick={() => openEdit(k)}>Edit</Button>
                      <Button small variant="danger" loading={busy === k.id} onClick={() => void remove(k)}>
                        Archive
                      </Button>
                    </>
                  )}
                </div>
              </m.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title="Edit FAQ" width={520}>
        {editing?.status === 'approved' && (
          <p style={{
            marginTop: 0, fontSize: 12, background: 'var(--warn-soft)', color: 'var(--warn)',
            padding: '8px 12px', borderRadius: 'var(--radius-sm)',
          }}>
            ⚠ Editing an approved FAQ returns it to <strong>draft</strong> — the AI stops using it until
            you approve the new wording (US-014).
          </p>
        )}
        <div style={{ display: 'grid', gap: 10 }}>
          <label>
            Question
            <input className="bn" value={editQ} onChange={(e) => setEditQ(e.target.value)} minLength={5} maxLength={500} />
          </label>
          <label>
            Answer
            <textarea className="bn" value={editA} onChange={(e) => setEditA(e.target.value)} minLength={5} maxLength={2000} rows={4} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <Button onClick={() => setEditing(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === editing?.id}
            disabled={editQ.trim().length < 5 || editA.trim().length < 5}
            onClick={() => editing && void saveEdit(editing, editQ.trim(), editA.trim())}>
            Save
          </Button>
        </div>
      </Dialog>

      <ConflictDialog
        open={conflict !== null}
        info={conflict?.info ?? null}
        onReapply={() => {
          const c = conflict
          setConflict(null)
          c?.retry()
        }}
        onKeepTheirs={() => {
          setConflict(null)
          setEditing(null)
          void load()
        }}
      />
    </div>
  )
}
