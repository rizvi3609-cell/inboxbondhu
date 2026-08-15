'use client'

/**
 * F4 — Settings → Team (US-006/007 — the screen that never existed):
 * members table with role change (admins can't touch the owner), removal
 * with the T2 5-step-cascade warning dialog, pending invitations with
 * expiry countdown + revoke, invite form (email + role, 20-pending cap and
 * verified-email gate surfaced as server messages).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'next/navigation'
import { MAX_PENDING_INVITATIONS_DEFAULT } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { dhakaDate, relativeTime } from '@/lib/format'
import { AnimatePresence, m, rowEnter } from '@/lib/motion'
import { Avatar, Badge, Button, SkeletonRow } from '@/components/ui/primitives'
import { Dialog, useToast } from '@/components/ui/overlay'

interface MemberRow {
  userId: string
  role: 'owner' | 'admin' | 'agent' | 'viewer'
  joinedAt: string
  name: string | null
  email: string | null
}

interface InvitationRow {
  id: string
  email: string
  role: 'admin' | 'agent' | 'viewer'
  expiresAt: string
}

const ROLE_TONE: Record<string, 'brand' | 'ai' | 'warn' | 'neutral'> = {
  owner: 'brand', admin: 'ai', agent: 'warn', viewer: 'neutral',
}
const ASSIGNABLE = ['admin', 'agent', 'viewer'] as const

export default function TeamPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { toast } = useToast()
  const [members, setMembers] = useState<MemberRow[] | null>(null)
  const [invitations, setInvitations] = useState<InvitationRow[]>([])
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<(typeof ASSIGNABLE)[number]>('agent')
  const [busy, setBusy] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null)

  const load = useCallback(async () => {
    const [m, i] = await Promise.all([
      api<MemberRow[]>(`/api/v1/w/${workspaceId}/members`),
      api<InvitationRow[]>(`/api/v1/w/${workspaceId}/invitations`),
    ])
    setMembers(m)
    setInvitations(i)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => setMembers([]))
  }, [load])

  async function invite(e: FormEvent) {
    e.preventDefault()
    setBusy('invite')
    try {
      await api(`/api/v1/w/${workspaceId}/invitations`, {
        method: 'POST', body: { email: inviteEmail.trim(), role: inviteRole },
      })
      toast('success', `Invitation sent to ${inviteEmail.trim()} (valid 7 days).`)
      setInviteEmail('')
      await load()
    } catch (err) {
      // Server messages carry the real rules: 20-pending cap, already-member,
      // never-owner — surface them verbatim.
      toast('error', err instanceof ApiFailure ? err.error.message : 'Invite failed.')
    } finally {
      setBusy(null)
    }
  }

  async function changeRole(member: MemberRow, role: string) {
    if (role === member.role) return
    setBusy(member.userId)
    try {
      await api(`/api/v1/w/${workspaceId}/members/${member.userId}`, {
        method: 'PATCH', body: { role },
      })
      toast('success', `${member.name ?? member.email} is now ${role}. (Audited; their cached role updates immediately.)`)
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Role change failed.')
      await load() // revert the select to server truth
    } finally {
      setBusy(null)
    }
  }

  async function doRemove() {
    if (!removeTarget) return
    setBusy(removeTarget.userId)
    try {
      await api(`/api/v1/w/${workspaceId}/members/${removeTarget.userId}`, { method: 'DELETE' })
      toast('success', `${removeTarget.name ?? removeTarget.email} removed — their sessions ended immediately.`)
      setRemoveTarget(null)
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Removal failed.')
    } finally {
      setBusy(null)
    }
  }

  async function revoke(inv: InvitationRow) {
    setBusy(inv.id)
    try {
      await api(`/api/v1/w/${workspaceId}/invitations/${inv.id}`, { method: 'DELETE' })
      toast('success', 'Invitation revoked.')
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Revoke failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section>
        <h3>Members</h3>
        {members === null ? (
          <><SkeletonRow /><SkeletonRow /></>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            <AnimatePresence initial={false}>
              {members.map((mem) => (
                <m.div key={mem.userId} {...rowEnter} style={{
                  background: 'var(--panel)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '10px 14px',
                  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                }}>
                  <Avatar name={mem.name ?? mem.email ?? '?'} id={mem.userId} size={32} />
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <strong>{mem.name ?? '—'}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {mem.email} · joined {dhakaDate(mem.joinedAt)}
                    </div>
                  </div>
                  <Badge tone={ROLE_TONE[mem.role] ?? 'neutral'}>{mem.role}</Badge>
                  {mem.role === 'owner' ? (
                    <span className="muted" style={{ fontSize: 11 }}>
                      Owner role changes only via ownership transfer.
                    </span>
                  ) : (
                    <>
                      <select
                        value={mem.role}
                        disabled={busy === mem.userId}
                        onChange={(e) => void changeRole(mem, e.target.value)}
                        aria-label={`Role for ${mem.name ?? mem.email}`}
                        style={{ width: 110 }}
                      >
                        {ASSIGNABLE.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                      <Button small variant="danger" onClick={() => setRemoveTarget(mem)}>Remove</Button>
                    </>
                  )}
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <section>
        <h3>Pending invitations {invitations.length > 0 && <span className="muted">({invitations.length}/{MAX_PENDING_INVITATIONS_DEFAULT})</span>}</h3>
        {invitations.length === 0 ? (
          <p className="muted" style={{ fontSize: 12 }}>None pending.</p>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            <AnimatePresence initial={false}>
              {invitations.map((inv) => (
                <m.div key={inv.id} {...rowEnter} style={{
                  background: 'var(--panel)', border: '1px dashed var(--border-strong)',
                  borderRadius: 'var(--radius-md)', padding: '10px 14px',
                  display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
                }}>
                  <span style={{ flex: 1, minWidth: 160 }}>
                    <strong>{inv.email}</strong>{' '}
                    <Badge tone={ROLE_TONE[inv.role] ?? 'neutral'}>{inv.role}</Badge>
                  </span>
                  <span className="muted mono-num" style={{ fontSize: 11 }}>
                    expires {relativeTime(inv.expiresAt).replace(' ago', '')} from now
                  </span>
                  <Button small loading={busy === inv.id} onClick={() => void revoke(inv)}>Revoke</Button>
                </m.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </section>

      <section>
        <h3>Invite a teammate</h3>
        <form onSubmit={invite} style={{
          background: 'var(--panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 14,
          display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap',
        }}>
          <label style={{ flex: 1, minWidth: 220, marginBottom: 0 }}>
            Email
            <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required placeholder="rony@example.com" />
          </label>
          <label style={{ width: 120, marginBottom: 0 }}>
            Role
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}>
              {ASSIGNABLE.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <Button variant="primary" type="submit" loading={busy === 'invite'} disabled={!inviteEmail.trim()}>
            Send invite
          </Button>
        </form>
        <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Invitations expire after 7 days · the invitee must verify their email before accepting ·
          nobody can be invited as owner.
        </p>
      </section>

      {/* T2 — the 5-step cascade, spelled out before the click */}
      <Dialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? removeTarget?.email}?`}
        width={480}
      >
        <p className="muted" style={{ marginTop: 0 }}>Removing a member immediately:</p>
        <ul className="muted" style={{ fontSize: 12, margin: '0 0 12px', paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>ends <strong>all</strong> of their active sessions (they are signed out mid-request),</li>
          <li>unassigns their conversations (threads stay, unassigned),</li>
          <li>revokes invitations they sent,</li>
          <li>tombstones the membership (history and audit rows survive),</li>
          <li>records the removal in the audit log.</li>
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button variant="danger" loading={busy === removeTarget?.userId} onClick={() => void doRemove()}>
            Remove member
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
