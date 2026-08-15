'use client'

/**
 * §4.2 page transitions: content fades/slides y:6→0 in 200 ms on every route
 * change inside the workspace shell. template.tsx remounts per navigation —
 * exactly the hook point Next gives us for this.
 */
import type { ReactNode } from 'react'
import { m, pageEnter } from '@/lib/motion'

export default function WorkspaceTemplate({ children }: { children: ReactNode }) {
  return <m.div {...pageEnter}>{children}</m.div>
}
