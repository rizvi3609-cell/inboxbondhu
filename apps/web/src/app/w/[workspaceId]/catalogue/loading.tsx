import { Skeleton } from '@/components/ui/primitives'

export default function CatalogueLoading() {
  return (
    <div>
      <div style={{ height: 40, marginBottom: 14 }} />
      <div style={{ display: 'grid', gap: 1 }}>
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} style={{ display: 'flex', gap: 16, padding: '12px 12px', borderBottom: '1px solid var(--border)' }}>
            <Skeleton width={90} height={13} />
            <Skeleton width="22%" height={13} />
            <Skeleton width={70} height={13} />
            <Skeleton width={64} height={18} radius={999} />
            <Skeleton width={64} height={18} radius={999} />
          </div>
        ))}
      </div>
    </div>
  )
}
