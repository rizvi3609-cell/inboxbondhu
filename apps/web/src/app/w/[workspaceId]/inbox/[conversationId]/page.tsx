'use client'

/**
 * F2 — mobile/deep-link thread route (§6.1: below 1024 px the thread is its
 * own screen). Desktop visits get the same view — a shared/deep link always
 * works.
 */
import { useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { ConversationDetailView } from '@inboxbondhu/contracts'
import { Thread } from '@/components/inbox/Thread'
import { ThreadHeader } from '@/components/inbox/ThreadHeader'

export default function ConversationPage() {
  const { workspaceId, conversationId } = useParams<{ workspaceId: string; conversationId: string }>()
  const [conv, setConv] = useState<ConversationDetailView | null>(null)
  const [refresh, setRefresh] = useState(0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 40px)', minHeight: 0 }}>
      <div style={{ marginBottom: 8 }}>
        <Link href={`/w/${workspaceId}/inbox`} className="muted" style={{ fontSize: 12 }}>
          ← Inbox
        </Link>
      </div>
      {conv && (
        <ThreadHeader workspaceId={workspaceId} conv={conv} onChanged={() => setRefresh((n) => n + 1)} />
      )}
      <div style={{ flex: 1, minHeight: 0, paddingTop: 10 }}>
        <Thread
          key={conversationId}
          refreshSignal={refresh}
          workspaceId={workspaceId}
          conversationId={conversationId}
          onConversationChange={setConv}
        />
      </div>
    </div>
  )
}
