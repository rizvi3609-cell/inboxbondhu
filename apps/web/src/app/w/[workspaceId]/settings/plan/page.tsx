'use client'

/**
 * F4 — Settings → Plan & usage (§6.7): current plan card, animated quota
 * Meters (conversations + products) with the 80/100% color states, live
 * quota.warning socket updates, owner-only change-plan with confirm.
 * Non-owners see usage (#68) — /plan itself is owner-only and handled via
 * graceful 403.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { PLAN_LIMITS, type PlanView, type QuotaStatusView } from '@inboxbondhu/contracts/views'
import { api, ApiFailure } from '@/lib/api-client'
import { useRealtime } from '@/lib/realtime-context'
import { Badge, Button, Meter, Skeleton } from '@/components/ui/primitives'
import { Dialog, useToast } from '@/components/ui/overlay'

// Numbers come from contracts' PLAN_LIMITS — the enforcement source
// (hardcoding-audit fix). Only labels/blurbs are display-local.
const PLAN_COPY: Record<string, { label: string; blurb: string }> = {
  trial: { label: 'Trial', blurb: '14 days to prove it on your Page' },
  starter: { label: 'Starter', blurb: 'For one busy Page' },
  growth: { label: 'Growth', blurb: 'For multi-Page sellers' },
}
const PLAN_INFO: Record<string, { label: string; conversations: number; products: number; blurb: string }> =
  Object.fromEntries(
    Object.entries(PLAN_COPY).map(([id, copy]) => [
      id,
      { ...copy, conversations: PLAN_LIMITS[id]?.conversations ?? 0, products: PLAN_LIMITS[id]?.products ?? 0 },
    ]),
  )

export default function PlanPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe } = useRealtime()
  const { toast } = useToast()
  const [plan, setPlan] = useState<PlanView | null>(null)
  const [usage, setUsage] = useState<QuotaStatusView | null>(null)
  const [ownerOnly, setOwnerOnly] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      api<PlanView>(`/api/v1/w/${workspaceId}/plan`),       // owner-only
      api<QuotaStatusView>(`/api/v1/w/${workspaceId}/usage`), // admin+
    ])
    if (results[0].status === 'fulfilled') setPlan(results[0].value)
    else if (results[0].reason instanceof ApiFailure && results[0].reason.status === 403) setOwnerOnly(true)
    if (results[1].status === 'fulfilled') setUsage(results[1].value)
  }, [workspaceId])

  useEffect(() => {
    void load().catch(() => undefined)
  }, [load])

  // Live: the quota.warning socket refreshes the meters (§4.2).
  useEffect(
    () =>
      subscribe((event) => {
        if (event === 'quota.warning') void load().catch(() => undefined)
      }),
    [subscribe, load],
  )

  async function changePlan() {
    if (!target) return
    setBusy(true)
    try {
      await api(`/api/v1/w/${workspaceId}/plan/change`, { method: 'POST', body: { plan: target } })
      toast('success', `Plan changed to ${target}. ${target !== 'trial' ? 'Your current-period limit rises immediately.' : ''}`)
      setTarget(null)
      await load()
    } catch (err) {
      toast('error', err instanceof ApiFailure ? err.error.message : 'Plan change failed.')
    } finally {
      setBusy(false)
    }
  }

  if (!plan && !usage && !ownerOnly) {
    return <div style={{ display: 'grid', gap: 12 }}><Skeleton height={90} radius={12} /><Skeleton height={120} radius={12} /></div>
  }

  const current = plan?.plan ?? usage?.plan ?? 'trial'

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 640 }}>
      <div style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 16,
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{PLAN_INFO[current]?.label ?? current}</h3>
            {(plan?.aiPaused ?? usage?.aiPaused) && (
              <Badge tone="danger">AI paused — quota reached</Badge>
            )}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>
            {PLAN_INFO[current]?.blurb} · period {plan?.periodKey ?? usage?.periodKey}
          </span>
        </div>
      </div>

      <div style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, display: 'grid', gap: 14 }}>
        {plan ? (
          <>
            <Meter value={plan.conversations.used} max={plan.conversations.limit} label="Conversations this month" />
            <Meter value={plan.products.used} max={plan.products.limit} label="Products" />
          </>
        ) : usage ? (
          <Meter value={usage.conversationsUsed} max={usage.conversationsLimit} label="Conversations this month" />
        ) : null}
        {(plan?.aiPaused ?? usage?.aiPaused) && (
          <p style={{ margin: 0, fontSize: 12, background: 'var(--danger-soft)', color: 'var(--danger)', padding: '8px 12px', borderRadius: 'var(--radius-sm)' }}>
            The AI assistant is paused for this period — <strong>human replies keep working</strong>.
            Upgrading raises the limit immediately.
          </p>
        )}
      </div>

      {ownerOnly && !plan ? (
        <p className="muted" style={{ fontSize: 12 }}>Plan changes are owner-only. Ask the workspace owner to upgrade.</p>
      ) : plan ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          {Object.entries(PLAN_INFO).filter(([id]) => id !== 'trial').map(([id, info]) => (
            <div key={id} style={{
              background: 'var(--panel)', borderRadius: 'var(--radius-md)', padding: 14,
              border: `1px solid ${id === current ? 'var(--brand)' : 'var(--border)'}`,
              display: 'grid', gap: 6, alignContent: 'start',
            }}>
              <strong>{info.label}</strong>
              <span className="muted" style={{ fontSize: 12 }}>
                {info.conversations.toLocaleString()} conversations/mo · {info.products.toLocaleString()} products
              </span>
              {id === current ? (
                <Badge tone="brand">Current plan</Badge>
              ) : (
                <Button small variant="primary" onClick={() => setTarget(id)}>
                  Switch to {info.label}
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <Dialog open={target !== null} onClose={() => setTarget(null)} title={`Switch to ${PLAN_INFO[target ?? '']?.label}?`}>
        <p className="muted" style={{ marginTop: 0 }}>
          {target && plan && PLAN_INFO[target]!.conversations > PLAN_INFO[plan.plan]!.conversations
            ? 'Upgrades raise your current-period limits immediately — if the AI is paused, it resumes on the next message.'
            : 'Downgrades never lower the current period\u2019s limit — the new cap applies from next month.'}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={() => setTarget(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void changePlan()}>Confirm switch</Button>
        </div>
      </Dialog>
    </div>
  )
}
