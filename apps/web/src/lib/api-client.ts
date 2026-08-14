/**
 * Typed fetch against the frozen API contract. Relative URLs only — the
 * Next.js rewrite proxies /api/* to the api origin, so cookies stay
 * first-party. Injects X-CSRF-Token (mirror of the ib_csrf cookie) on every
 * mutation and understands the §6.2 envelopes + §6.3 error codes.
 */

export interface ApiError {
  code: string
  message: string
  requestId?: string
  currentVersion?: number
  conflictingFields?: string[]
  details?: unknown
}

export class ApiFailure extends Error {
  readonly error: ApiError
  readonly status: number
  constructor(status: number, error: ApiError) {
    super(error.message)
    this.status = status
    this.error = error
  }
}

function csrfToken(): string {
  const m = /(?:^|;\s*)ib_csrf=([^;]+)/.exec(document.cookie)
  return m?.[1] ? decodeURIComponent(m[1]) : ''
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  ifMatch?: number
  idempotencyKey?: string
}

let refreshInFlight: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  refreshInFlight ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => {
        refreshInFlight = null
      }, 0)
    })
  return refreshInFlight
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken()
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (opts.ifMatch !== undefined) headers['If-Match'] = String(opts.ifMatch)
  if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey

  const doFetch = () =>
    fetch(path, {
      method,
      headers,
      credentials: 'include',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })

  let res = await doFetch()

  // One transparent refresh on 401 (access token is 15 min).
  if (res.status === 401 && !path.includes('/auth/')) {
    if (await tryRefresh()) {
      if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken()
      res = await doFetch()
    }
  }

  if (res.status === 204) return undefined as T
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: ApiError }
  if (!res.ok) {
    const err = json.error ?? { code: 'INTERNAL', message: `HTTP ${res.status}` }
    if (res.status === 401 && typeof window !== 'undefined' && !path.includes('/auth/')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`
    }
    throw new ApiFailure(res.status, err)
  }
  return json.data as T
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
