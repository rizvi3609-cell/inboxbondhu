import { SkeletonRow } from '@/components/ui/primitives'

export default function InboxLoading() {
  return (
    <div>
      <div style={{ height: 40, marginBottom: 14 }} />
      <div style={{ display: 'grid', gap: 6 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            <SkeletonRow />
          </div>
        ))}
      </div>
    </div>
  )
}
