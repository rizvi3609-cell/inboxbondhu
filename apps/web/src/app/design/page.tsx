'use client'

/**
 * F0 gate route: every Bondhu primitive rendered together, both themes.
 * Not linked from navigation; exists so design changes are reviewable at a
 * glance and visual regressions are obvious. (Storybook-less by choice —
 * bundle budget & spec §8.5.)
 */
import { useState } from 'react'
import { MotionRoot, m, rowEnter, cardEnter } from '@/lib/motion'
import {
  Avatar, Badge, Button, Card, CheckDraw, EmptyState, Kbd, Meter,
  Skeleton, SkeletonRow, Spinner, Tabs, TypingDots,
} from '@/components/ui/primitives'
import { ConflictDialog, Dialog, ToastProvider, useToast } from '@/components/ui/overlay'
import { ThemeToggle } from '@/components/ui/ThemeToggle'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={{ display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {children}
    </Card>
  )
}

function DemoContent() {
  const { toast } = useToast()
  const [tab, setTab] = useState<'all' | 'open' | 'pending'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [conflictOpen, setConflictOpen] = useState(false)
  const [meterVal, setMeterVal] = useState(64)
  const [rows, setRows] = useState([1, 2])

  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: 24, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0, flex: 1 }}>Bondhu design system</h1>
        <ThemeToggle />
      </div>

      <Section title="Buttons">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="primary">Primary</Button>
          <Button>Ghost</Button>
          <Button variant="subtle">Subtle</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="primary" loading>Saving…</Button>
          <Button small>Small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Section>

      <Section title="Badges — status map (one source, spec §6)">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Badge tone="ai" breathing>🤖 AI handling</Badge>
          <Badge tone="human">🙋 Human</Badge>
          <Badge tone="open">open</Badge>
          <Badge tone="pending">pending</Badge>
          <Badge tone="resolved">resolved</Badge>
          <Badge tone="Confirmed">Confirmed</Badge>
          <Badge tone="Shipped">Shipped</Badge>
          <Badge tone="Delivered">Delivered</Badge>
          <Badge tone="Cancelled">Cancelled</Badge>
          <Badge tone="approved">approved</Badge>
          <Badge tone="draft">draft</Badge>
          <Badge tone="accent">৳2,500</Badge>
        </div>
      </Section>

      <Section title="Avatars — deterministic hue + provider glyph">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Avatar name="Nusrat Jahan" id="65f1a2b3c4d5e6f7a8b9c0d1" provider="facebook" />
          <Avatar name="Karim Ahmed" id="65f1a2b3c4d5e6f7a8b9c0d2" provider="instagram" />
          <Avatar name="Fatima Begum" id="65f1a2b3c4d5e6f7a8b9c0d3" />
          <Avatar name="রহিমা খাতুন" id="xyz" size={44} provider="facebook" />
        </div>
      </Section>

      <Section title="Tabs — sliding active state">
        <Tabs
          tabs={[
            { id: 'all', label: 'All', count: 12 },
            { id: 'open', label: 'Open', count: 5 },
            { id: 'pending', label: 'Pending', count: 2 },
          ] as const}
          active={tab}
          onChange={setTab}
        />
      </Section>

      <Section title="Skeletons — shimmer, zero CLS">
        <SkeletonRow />
        <SkeletonRow />
        <div style={{ display: 'flex', gap: 12 }}>
          <Skeleton width={120} height={60} radius={12} />
          <Skeleton width={120} height={60} radius={12} />
          <Skeleton width={120} height={60} radius={12} />
        </div>
      </Section>

      <Section title="Quota meter — amber at 80%, red at 100% (spec §4.2)">
        <Meter value={meterVal} max={100} label="Conversations this month" />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button small onClick={() => setMeterVal(64)}>64%</Button>
          <Button small onClick={() => setMeterVal(85)}>85%</Button>
          <Button small onClick={() => setMeterVal(100)}>100%</Button>
        </div>
      </Section>

      <Section title="Motion — row entrance spring (new conversation)">
        <div style={{ display: 'grid', gap: 6 }}>
          {rows.map((r) => (
            <m.div key={r} {...rowEnter} className={r === rows[rows.length - 1] ? 'anim-flash' : undefined}
              style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
              <Avatar name={`Customer ${r}`} id={`row-${r}`} size={28} provider="facebook" />
              <span style={{ flex: 1 }}>Conversation #{r} <span className="bn muted">— dam koto bhaiya?</span></span>
              <Badge tone="ai">🤖 AI</Badge>
            </m.div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button small variant="primary" onClick={() => setRows((p) => [...p, (p[p.length - 1] ?? 0) + 1])}>
            Simulate message.created
          </Button>
          <Button small onClick={() => setRows([1, 2])}>Reset</Button>
        </div>
      </Section>

      <Section title="Indicators">
        <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
          <span><Spinner /> loading</span>
          <span><TypingDots /> <span className="muted" style={{ marginLeft: 6 }}>AI typing</span></span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><CheckDraw /> import done</span>
          <span>Press <Kbd>j</Kbd> <Kbd>k</Kbd> to navigate, <Kbd>/</Kbd> to search</span>
        </div>
      </Section>

      <Section title="Overlays">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
          <Button onClick={() => setConflictOpen(true)}>409 conflict dialog (C-6)</Button>
          <Button onClick={() => toast('success', 'Order ORD-2026-00042 confirmed')}>Success toast</Button>
          <Button onClick={() => toast('error', 'Something went wrong.', '01M013D14JQ0J9NDA9YM68KXEP')}>Error toast (persists)</Button>
          <Button onClick={() => toast('warn', 'Meta window closes in 47 minutes')}>Warn toast</Button>
        </div>
      </Section>

      <Section title="Empty state">
        <EmptyState
          icon="💬"
          title="No conversations yet"
          hint="Connect a Facebook Page in Settings → Channels and customer DMs will appear here within seconds."
          action={<Button variant="primary">Connect a Page</Button>}
        />
      </Section>

      <m.div {...cardEnter}>
        <Card style={{ borderColor: 'var(--brand)', background: 'var(--brand-soft)' }}>
          <strong>Bengali rendering:</strong>{' '}
          <span className="bn">এই জামাটার দাম কত? স্টকে আছে কি?</span>{' '}
          <span className="muted">· mixed Banglish: dam koto bhaiya? stock e ase?</span>
        </Card>
      </m.div>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title="Remove Rony from the team?">
        <p className="muted" style={{ marginTop: 0 }}>
          Their sessions end immediately, assignments are cleared, and their invitations are revoked. This is audited.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => setDialogOpen(false)}>Remove member</Button>
        </div>
      </Dialog>

      <ConflictDialog
        open={conflictOpen}
        info={{
          conflictingFields: ['maxDiscountPercent', 'tone'],
          mine: { maxDiscountPercent: 15, tone: 'friendly' },
          theirs: { maxDiscountPercent: 10, tone: 'formal' },
        }}
        onReapply={() => setConflictOpen(false)}
        onKeepTheirs={() => setConflictOpen(false)}
      />
    </main>
  )
}

export default function DesignPage() {
  return (
    <MotionRoot>
      <ToastProvider>
        <DemoContent />
      </ToastProvider>
    </MotionRoot>
  )
}
