'use client'

/**
 * Overlays: Dialog (incl. the C-6 409-diff variant), Toasts, Sheet.
 * Focus trapped + restored (spec §7.4); backdrop fades; springs per §4.1.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, m, dialogEnter, rowEnter } from '@/lib/motion'
import { Button } from './primitives'

/* ── Dialog ──────────────────────────────────────────────────────────────── */

export function Dialog({ open, onClose, title, children, width = 440 }: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: number
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement
    const panel = panelRef.current
    panel?.querySelector<HTMLElement>('button, input, textarea, select, a[href]')?.focus()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && panel) {
        // Minimal focus trap.
        const focusables = [...panel.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')]
          .filter((el) => !el.hasAttribute('disabled'))
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreRef.current?.focus()
    }
  }, [open, onClose])

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgb(0 0 0 / 0.45)', display: 'grid', placeItems: 'center', padding: 16,
          }}
        >
          <m.div
            ref={panelRef}
            role="dialog" aria-modal="true" aria-label={title}
            {...dialogEnter}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: width, maxHeight: '85vh', overflowY: 'auto',
              background: 'var(--panel)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-2)', padding: 20,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, flex: 1 }}>{title}</h3>
              <Button small aria-label="Close" onClick={onClose}>✕</Button>
            </div>
            {children}
          </m.div>
        </m.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

/* ── ConflictDialog (C-6: 409 → diff + reapply, NEVER silent retry) ──────── */

export interface ConflictInfo {
  /** Fields the server says collided (from the VERSION_CONFLICT envelope). */
  conflictingFields: string[]
  /** My attempted values, keyed by field. */
  mine: Record<string, unknown>
  /** Fresh server values after refetch, keyed by field. */
  theirs: Record<string, unknown>
}

export function ConflictDialog({ open, info, onReapply, onKeepTheirs }: {
  open: boolean
  info: ConflictInfo | null
  onReapply: () => void
  onKeepTheirs: () => void
}) {
  return (
    <Dialog open={open && info !== null} onClose={onKeepTheirs} title="Someone else changed this" width={520}>
      <p className="muted" style={{ marginTop: 0 }}>
        These fields were modified while you were editing. Review the difference, then choose.
      </p>
      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {info?.conflictingFields.map((field) => (
          <div key={field} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--muted)', marginBottom: 4 }}>
              {field}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12 }}>
              <div>
                <span className="muted">Yours: </span>
                <span style={{ color: 'var(--warn)' }}>{JSON.stringify(info.mine[field] ?? '—')}</span>
              </div>
              <div>
                <span className="muted">Theirs (current): </span>
                <span style={{ color: 'var(--brand-strong)' }}>{JSON.stringify(info.theirs[field] ?? '—')}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onClick={onKeepTheirs}>Keep theirs</Button>
        <Button variant="primary" onClick={onReapply}>Reapply my change</Button>
      </div>
    </Dialog>
  )
}

/* ── Toasts (§4.3: stacked bottom-right, layout-animated) ────────────────── */

export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'info' | 'warn'
  text: string
  /** e.g. a requestId — rendered small + copyable. */
  detail?: string
}

interface ToastApi {
  toast: (kind: ToastItem['kind'], text: string, detail?: string) => void
}

const ToastCtx = createContext<ToastApi>({ toast: () => undefined })

export function useToast(): ToastApi {
  return useContext(ToastCtx)
}

const TOAST_ICON: Record<ToastItem['kind'], string> = {
  success: '✓', error: '✕', info: 'ℹ', warn: '⚠',
}
const TOAST_COLOR: Record<ToastItem['kind'], string> = {
  success: 'var(--ok)', error: 'var(--danger)', info: 'var(--brand)', warn: 'var(--warn)',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback((kind: ToastItem['kind'], text: string, detail?: string) => {
    const id = nextId.current
    nextId.current += 1
    setItems((prev) => [...prev.slice(-4), { id, kind, text, ...(detail ? { detail } : {}) }])
    // Errors persist (manual dismiss); the rest auto-dismiss at 3.5 s (§4.3).
    if (kind !== 'error') setTimeout(() => dismiss(id), 3_500)
  }, [dismiss])

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {typeof document !== 'undefined' && createPortal(
        <div
          aria-live="polite"
          style={{
            position: 'fixed', right: 16, bottom: 16, zIndex: 200,
            display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 380,
          }}
        >
          <AnimatePresence mode="popLayout">
            {items.map((t) => (
              <m.div
                key={t.id}
                layout
                {...rowEnter}
                style={{
                  background: 'var(--panel)', border: '1px solid var(--border)',
                  borderLeft: `3px solid ${TOAST_COLOR[t.kind]}`,
                  borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-2)',
                  padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start',
                  cursor: 'pointer',
                }}
                onClick={() => dismiss(t.id)}
              >
                <span style={{ color: TOAST_COLOR[t.kind], fontWeight: 800, fontSize: 13 }}>{TOAST_ICON[t.kind]}</span>
                <span style={{ flex: 1, fontSize: 13 }}>
                  {t.text}
                  {t.detail && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void navigator.clipboard?.writeText(t.detail!)
                      }}
                      style={{
                        display: 'block', font: 'inherit', fontSize: 11, color: 'var(--muted)',
                        background: 'none', border: 'none', padding: 0, marginTop: 2, cursor: 'copy',
                      }}
                      title="Copy"
                    >
                      {t.detail} ⧉
                    </button>
                  )}
                </span>
              </m.div>
            ))}
          </AnimatePresence>
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}
