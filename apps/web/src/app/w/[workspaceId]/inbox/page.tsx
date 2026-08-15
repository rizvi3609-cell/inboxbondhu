'use client'

/**
 * F2 — Inbox (§6.1, the Act 6 split-pane): ≥1024 px list+thread side by
 * side; below that the list navigates to the thread route. Selecting a
 * conversation on desktop swaps the right pane WITHOUT route change (fast),
 * keeping the URL shareable via replaceState.
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import type { ConversationDetailView } from '@inboxbondhu/contracts/views'
import { ConversationList } from '@/components/inbox/ConversationList'
import { Thread } from '@/components/inbox/Thread'
import { ThreadHeader } from '@/components/inbox/ThreadHeader'
import { EmptyState } from '@/components/ui/primitives'

function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(true)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setDesktop(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return desktop
}

export default function InboxPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const router = useRouter()
  const search = useSearchParams()
  const desktop = useIsDesktop()
  const [activeId, setActiveId] = useState<string | null>(search.get('c'))
  const [activeConv, setActiveConv] = useState<ConversationDetailView | null>(null)
  const [headerRefresh, setHeaderRefresh] = useState(0)

  const select = useCallback((id: string) => {
    if (desktop) {
      setActiveId(id)
      // Shareable URL without a navigation (the pane swap is instant).
      window.history.replaceState(null, '', `/w/${workspaceId}/inbox?c=${id}`)
    } else {
      router.push(`/w/${workspaceId}/inbox/${id}`)
    }
  }, [desktop, router, workspaceId])

  return (
    <div style={{ display: 'flex', gap: 16, height: 'calc(100vh - 40px)', minHeight: 0 }}>
      <section style={{ width: desktop ? 380 : '100%', flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }} aria-label="Conversations">
        <h1 style={{ marginBottom: 10 }}>Inbox</h1>
        <ConversationList workspaceId={workspaceId} activeId={activeId} onSelect={select} />
      </section>

      {desktop && (
        <section style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', paddingTop: 42 }} aria-label="Conversation">
          {activeId ? (
            <>
              {activeConv && activeConv.id === activeId && (
                <ThreadHeader
                  workspaceId={workspaceId}
                  conv={activeConv}
                  onChanged={() => setHeaderRefresh((n) => n + 1)}
                />
              )}
              <div style={{ flex: 1, minHeight: 0, paddingTop: 10 }}>
                <Thread
                  key={activeId}
                  refreshSignal={headerRefresh}
                  workspaceId={workspaceId}
                  conversationId={activeId}
                  onConversationChange={setActiveConv}
                />
              </div>
            </>
          ) : (
            <EmptyState
              icon="👈"
              title="Pick a conversation"
              hint="Select from the list — or press j / k to move and Enter to open."
            />
          )}
        </section>
      )}
    </div>
  )
}
