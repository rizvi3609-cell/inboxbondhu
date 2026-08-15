import { Skeleton } from '@/components/ui/primitives'

export default function AnalyticsLoading() {
  return (
    <div>
      <div style={{ height: 40, marginBottom: 14 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} height={92} radius={12} />
        ))}
      </div>
      <Skeleton height={160} radius={12} style={{ marginTop: 16 }} />
    </div>
  )
}
