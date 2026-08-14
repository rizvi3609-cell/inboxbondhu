'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { api, ApiFailure } from '@/lib/api-client'
import { taka, type ProductRow } from '@/lib/types'
import { useRealtime } from '@/lib/realtime-context'

interface ImportStatus {
  id: string
  status: string
  totalRows: number
  processedRows: number
  errorRows?: number
}

export default function CataloguePage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const { subscribe } = useRealtime()
  const [rows, setRows] = useState<ProductRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState<ImportStatus | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const data = await api<{ products: ProductRow[] }>(`/api/v1/w/${workspaceId}/products`)
    setRows(data.products)
  }, [workspaceId])

  useEffect(() => {
    void load().catch((err) => setError(err instanceof ApiFailure ? err.error.message : 'Load failed.'))
  }, [load])

  useEffect(
    () => subscribe((event, payload) => {
      if (event === 'import.progress') {
        setImporting((prev) => (prev ? { ...prev, ...payload } as ImportStatus : prev))
        void load().catch(() => undefined)
      }
    }),
    [subscribe, load],
  )

  async function uploadCsv(file: File) {
    setError(null)
    try {
      const content = await file.text() // strict UTF-8 checked server-side
      const started = await api<{ importId: string }>(`/api/v1/w/${workspaceId}/products/import`, {
        method: 'POST',
        body: { fileName: file.name, content, encoding: 'utf8' },
      })
      setImporting({ id: started.importId, status: 'processing', totalRows: 0, processedRows: 0 })
      // Poll #51 until terminal (socket import.progress also updates it).
      const poll = setInterval(() => {
        void api<ImportStatus>(`/api/v1/w/${workspaceId}/imports/${started.importId}`)
          .then((s) => {
            setImporting(s)
            if (['completed', 'failed', 'cancelled'].includes(s.status)) {
              clearInterval(poll)
              void load()
            }
          })
          .catch(() => clearInterval(poll))
      }, 1500)
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Import failed to start.')
    }
  }

  async function archive(p: ProductRow) {
    setError(null)
    try {
      await api(`/api/v1/w/${workspaceId}/products/${p.id}`, { method: 'DELETE', ifMatch: p.version })
      await load()
    } catch (err) {
      setError(err instanceof ApiFailure ? err.error.message : 'Archive failed.')
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Catalogue</h1>
        <div style={{ marginLeft: 'auto' }}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadCsv(f)
              e.target.value = ''
            }}
          />
          <button className="primary" onClick={() => fileRef.current?.click()}>Import CSV</button>
        </div>
      </div>
      {importing && (
        <div className="card" style={{ margin: '12px 0' }}>
          Import <strong>{importing.status}</strong>
          {importing.totalRows > 0 && <> — {importing.processedRows}/{importing.totalRows} rows{importing.errorRows ? `, ${importing.errorRows} errors` : ''}</>}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      {rows.length === 0 ? (
        <div className="card muted" style={{ marginTop: 12 }}>No products. Import a CSV (sku,name,price,stock,…) or add via the API.</div>
      ) : (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr><th>SKU</th><th>Name</th><th>Price</th><th>Stock (reserved)</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const stock = p.variants.reduce((s, v) => s + v.stock, 0)
              const reserved = p.variants.reduce((s, v) => s + v.reserved, 0)
              return (
                <tr key={p.id}>
                  <td>{p.sku}</td>
                  <td><strong>{p.name}</strong> <span className="muted">({p.variants.length} variants)</span></td>
                  <td>{taka(p.basePriceMinor)}</td>
                  <td>{stock} <span className="muted">({reserved} reserved)</span></td>
                  <td><span className={`badge ${p.status}`}>{p.status}</span></td>
                  <td>{p.status !== 'archived' && <button onClick={() => void archive(p)}>Archive</button>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
