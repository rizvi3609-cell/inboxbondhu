'use client'

/**
 * Motion setup (spec §4) — LazyMotion with domAnimation only (~5 kB gz).
 * Import `m` from here, NEVER `motion` from 'motion/react' (that pulls the
 * full bundle). Shared spring + variants keep every entrance consistent.
 */
import { LazyMotion, domAnimation, m, AnimatePresence, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

export { m, AnimatePresence, useReducedMotion }

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  )
}

/** The one spring (§4.1): stiffness 420 / damping 32. */
export const spring = { type: 'spring', stiffness: 420, damping: 32 } as const

/** List row entrance — new conversation / order / toast (§4.2). */
export const rowEnter = {
  initial: { opacity: 0, y: -12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.15 } },
  transition: spring,
} as const

/** Message bubble entrance (§4.2). */
export const bubbleEnter = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: spring,
} as const

/** Card / auth screen entrance (§4.2). */
export const cardEnter = {
  initial: { opacity: 0, y: 10, scale: 0.97 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: spring,
} as const

/** Page content transition (§4.2 — template.tsx). */
export const pageEnter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
} as const

/** Dialog spring (§4.2). */
export const dialogEnter = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97, transition: { duration: 0.12 } },
  transition: spring,
} as const

/** Mobile bottom sheet (§4.2). */
export const sheetEnter = {
  initial: { y: '100%' },
  animate: { y: 0 },
  exit: { y: '100%', transition: { duration: 0.2 } },
  transition: spring,
} as const
