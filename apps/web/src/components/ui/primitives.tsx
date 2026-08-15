'use client'

/**
 * Bondhu primitives (spec §3.4) — hand-built, no component library.
 * Compositor-only animation; every interactive element keyboard-reachable.
 */
import {
  forwardRef, useEffect, useId, useState,
  type ButtonHTMLAttributes, type CSSProperties, type ReactNode,
} from 'react'

/* ── Button ──────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle'

const BUTTON_STYLES: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--brand)', borderColor: 'var(--brand)', color: '#fff' },
  ghost: { background: 'transparent', borderColor: 'var(--border)', color: 'var(--text)' },
  subtle: { background: 'var(--panel-2)', borderColor: 'transparent', color: 'var(--text)' },
  danger: { background: 'transparent', borderColor: 'var(--danger)', color: 'var(--danger)' },
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  loading?: boolean
  small?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', loading = false, small = false, disabled, children, style, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      style={{
        font: 'inherit', fontWeight: 550, cursor: 'pointer',
        border: '1px solid', borderRadius: 'var(--radius-sm)',
        padding: small ? '4px 10px' : '7px 14px',
        fontSize: small ? 12 : 13,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        transition: 'transform var(--dur-fast) ease, opacity var(--dur-fast) ease, background-color var(--dur-fast) ease',
        opacity: disabled || loading ? 0.55 : 1,
        position: 'relative',
        ...BUTTON_STYLES[variant],
        ...style,
      }}
      onMouseDown={(e) => {
        // §4.3 press: scale(.98), spring back on release via transition.
        ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(0.98)'
      }}
      onMouseUp={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'
      }}
      {...rest}
    >
      {/* Width preserved during loading: label goes invisible, spinner overlays. */}
      <span style={{ visibility: loading ? 'hidden' : 'visible', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {children}
      </span>
      {loading && (
        <span style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
          <Spinner size={14} />
        </span>
      )}
    </button>
  )
})

/* ── Spinner ─────────────────────────────────────────────────────────────── */

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      style={{
        width: size, height: size, display: 'inline-block',
        border: '2px solid var(--border-strong)', borderTopColor: 'var(--brand)',
        borderRadius: '50%', animation: 'spin 0.7s linear infinite',
      }}
    />
  )
}

/* ── Badge (spec §6: status + AI variants) ───────────────────────────────── */

type BadgeTone = 'ai' | 'human' | 'ok' | 'warn' | 'danger' | 'neutral' | 'brand' | 'accent'

const BADGE_TONES: Record<BadgeTone, CSSProperties> = {
  ai: { background: 'var(--ai-soft)', color: 'var(--ai)' },
  human: { background: 'var(--warn-soft)', color: 'var(--warn)' },
  ok: { background: 'var(--ok-soft)', color: 'var(--ok)' },
  warn: { background: 'var(--warn-soft)', color: 'var(--warn)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)' },
  neutral: { background: 'var(--panel-2)', color: 'var(--muted)' },
  brand: { background: 'var(--brand-soft)', color: 'var(--brand-strong)' },
  accent: { background: 'var(--accent-soft)', color: 'var(--accent)' },
}

/** Maps every backend status string to a tone — ONE place (spec §6). */
export function toneFor(status: string): BadgeTone {
  switch (status) {
    case 'ai': return 'ai'
    case 'human': return 'human'
    case 'open': case 'active': case 'approved': case 'completed': case 'Delivered': case 'Paid': case 'Confirmed': return 'ok'
    case 'pending': case 'draft': case 'processing': case 'AwaitingConfirmation': case 'Collecting': case 'Unpaid': case 'PartiallyPaid': case 'Processing': case 'Shipped': return 'warn'
    case 'failed': case 'Cancelled': case 'expired': case 'Refunded': return 'danger'
    case 'resolved': case 'archived': case 'cancelled': case 'disconnected': return 'neutral'
    default: return 'neutral'
  }
}

export function Badge({ tone, children, breathing = false, title }: {
  tone: BadgeTone | string
  children: ReactNode
  /** §4.2 "AI is handling" breathing glow. */
  breathing?: boolean
  title?: string
}) {
  const resolved = (tone in BADGE_TONES ? tone : toneFor(tone)) as BadgeTone
  return (
    <span
      className={breathing ? 'anim-breathe' : undefined}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        borderRadius: 999, padding: '2px 9px',
        fontSize: 11, fontWeight: 650, letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        ...BADGE_TONES[resolved],
      }}
    >
      {children}
    </span>
  )
}

/* ── Card ────────────────────────────────────────────────────────────────── */

export function Card({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', padding: 16, boxShadow: 'var(--shadow-1)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/* ── Skeleton (spec §4.2: shimmer, identical box sizes, zero CLS) ────────── */

export function Skeleton({ width = '100%', height = 14, radius = 6, style }: {
  width?: number | string; height?: number | string; radius?: number; style?: CSSProperties
}) {
  return (
    <span
      aria-hidden
      style={{
        display: 'block', width, height, borderRadius: radius,
        background: 'var(--panel-2)', position: 'relative', overflow: 'hidden',
        ...style,
      }}
    >
      <span
        style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(90deg, transparent, rgb(255 255 255 / 0.35), transparent)',
          animation: 'shimmer 1.6s linear infinite',
        }}
      />
    </span>
  )
}

/** A skeleton list row matching ConversationRow's exact box (no CLS). */
export function SkeletonRow() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 14px' }}>
      <Skeleton width={36} height={36} radius={18} />
      <div style={{ flex: 1, display: 'grid', gap: 6 }}>
        <Skeleton width="45%" height={13} />
        <Skeleton width="80%" height={11} />
      </div>
      <Skeleton width={40} height={10} />
    </div>
  )
}

/* ── Avatar (deterministic hue from id — spec §3.4) ──────────────────────── */

export function Avatar({ name, id, size = 36, provider }: {
  name: string; id: string; size?: number; provider?: 'facebook' | 'instagram'
}) {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  const hue = hash % 360
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: size, height: size, flexShrink: 0 }}>
      <span
        aria-hidden
        style={{
          width: size, height: size, borderRadius: '50%',
          display: 'grid', placeItems: 'center',
          background: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.09 ${hue})`,
          fontSize: size * 0.36, fontWeight: 700, userSelect: 'none',
        }}
      >
        {initials || '?'}
      </span>
      {provider && (
        <span
          aria-label={provider}
          style={{
            position: 'absolute', right: -2, bottom: -2, width: 14, height: 14,
            borderRadius: '50%', fontSize: 8, display: 'grid', placeItems: 'center',
            background: provider === 'facebook' ? '#1877f2' : '#e1306c',
            color: '#fff', fontWeight: 700, border: '2px solid var(--panel)',
          }}
        >
          {provider === 'facebook' ? 'f' : 'ig'}
        </span>
      )}
    </span>
  )
}

/* ── EmptyState ──────────────────────────────────────────────────────────── */

export function EmptyState({ icon = '📭', title, hint, action }: {
  icon?: string; title: string; hint?: string; action?: ReactNode
}) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--muted)' }}>
      <div style={{ fontSize: 40, marginBottom: 12, filter: 'grayscale(0.3)' }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{title}</div>
      {hint && <div style={{ fontSize: 13, maxWidth: 380, margin: '0 auto' }}>{hint}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  )
}

/* ── Meter (quota bars — spec §4.2) ──────────────────────────────────────── */

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max === 0 ? 100 : Math.min(100, Math.round((value / max) * 100))
  const tone = pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--brand)'
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const t = requestAnimationFrame(() => setWidth(pct)) // animate on mount
    return () => cancelAnimationFrame(t)
  }, [pct])
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ fontWeight: 550 }}>{label}</span>
        <span className="mono-num muted">{value.toLocaleString()} / {max.toLocaleString()}</span>
      </div>
      <div
        role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-label={label}
        style={{ height: 8, borderRadius: 4, background: 'var(--panel-2)', overflow: 'hidden' }}
      >
        <div
          className={pct >= 80 && pct < 100 ? 'anim-pulse-once' : undefined}
          style={{
            height: '100%', width: `${width}%`, background: tone, borderRadius: 4,
            transition: 'width 600ms var(--ease-out-soft), background-color var(--dur-base) ease',
          }}
        />
      </div>
    </div>
  )
}

/* ── Tabs (sliding active indicator — spec §4.2) ─────────────────────────── */

export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: ReadonlyArray<{ id: T; label: string; count?: number }>
  active: T
  onChange: (id: T) => void
}) {
  const groupId = useId()
  return (
    <div role="tablist" style={{ display: 'inline-flex', gap: 2, background: 'var(--panel-2)', borderRadius: 'var(--radius-sm)', padding: 3 }}>
      {tabs.map((t) => {
        const isActive = t.id === active
        return (
          <button
            key={t.id}
            role="tab"
            id={`${groupId}-${t.id}`}
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            style={{
              font: 'inherit', fontSize: 12, fontWeight: isActive ? 650 : 500,
              border: 'none', cursor: 'pointer', borderRadius: 6, padding: '5px 12px',
              background: isActive ? 'var(--panel)' : 'transparent',
              color: isActive ? 'var(--text)' : 'var(--muted)',
              boxShadow: isActive ? 'var(--shadow-1)' : 'none',
              transition: 'background-color var(--dur-base) var(--ease-out-soft), color var(--dur-base) ease, box-shadow var(--dur-base) ease',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="mono-num" style={{ fontSize: 10, fontWeight: 700, background: 'var(--brand-soft)', color: 'var(--brand-strong)', borderRadius: 999, padding: '0 6px' }}>
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/* ── CheckDraw (SVG ✓ draw-in — spec §4.2 import completion) ─────────────── */

export function CheckDraw({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12.5l5 5L20 6.5"
        stroke="var(--ok)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={24} strokeDashoffset={24}
        style={{ animation: 'draw-check 400ms var(--ease-out-soft) forwards' }}
      />
    </svg>
  )
}

/* ── TypingDots (AI thinking — spec §4.2) ────────────────────────────────── */

export function TypingDots() {
  return (
    <span aria-label="AI is typing" style={{ display: 'inline-flex', gap: 3, padding: '2px 0' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 5, height: 5, borderRadius: '50%', background: 'var(--ai)',
            animation: `dot-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </span>
  )
}

/* ── Kbd ─────────────────────────────────────────────────────────────────── */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        font: 'inherit', fontSize: 10, fontWeight: 600, padding: '1px 5px',
        border: '1px solid var(--border-strong)', borderBottomWidth: 2,
        borderRadius: 4, background: 'var(--panel-2)', color: 'var(--muted)',
      }}
    >
      {children}
    </kbd>
  )
}
