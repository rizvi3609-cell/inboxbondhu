'use client'

/**
 * F5 — password strength meter (§6.8): animates red→amber→green as the
 * policy requirements are met. Client-side coaching only — the API's
 * passwordPolicy (contracts) is the enforcement; these checks mirror it.
 */

export interface StrengthResult {
  score: 0 | 1 | 2 | 3 | 4
  label: string
  ok: boolean
}

/** Mirrors contracts' passwordPolicy: ≥10 chars, upper, lower, digit. */
export function assess(password: string): StrengthResult {
  if (password.length === 0) return { score: 0, label: '', ok: false }
  let met = 0
  if (password.length >= 10) met += 1
  if (/[A-Z]/.test(password)) met += 1
  if (/[a-z]/.test(password)) met += 1
  if (/\d/.test(password)) met += 1
  const bonus = password.length >= 14 && met === 4 ? 1 : 0
  const score = Math.min(4, met === 4 ? 3 + bonus : Math.max(1, met - 1)) as StrengthResult['score']
  const label =
    met < 4 ? 'Keep going — needs 10+ chars with upper, lower and a digit'
    : bonus ? 'Excellent' : 'Good'
  return { score, label, ok: met === 4 }
}

const COLORS = ['transparent', 'var(--danger)', 'var(--warn)', 'var(--ok)', 'var(--brand)']

export function StrengthMeter({ password }: { password: string }) {
  const s = assess(password)
  return (
    <div aria-live="polite" style={{ display: 'grid', gap: 4, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i <= s.score ? COLORS[s.score] : 'var(--panel-2)',
            transition: 'background-color var(--dur-base) ease',
          }} />
        ))}
      </div>
      {s.label && (
        <span style={{ fontSize: 11, color: s.ok ? 'var(--ok)' : 'var(--muted)' }}>{s.label}</span>
      )}
    </div>
  )
}
