/**
 * §17.1 / ADR-012 — per-request CSP nonce (the PRD's literal `script-src
 * 'self'` breaks Next.js hydration; nonce + strict-dynamic is stricter),
 * plus session-presence redirects: no ib_at cookie → /login for app routes.
 */
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/register', '/verify', '/reset', '/unlock', '/forgot', '/design']

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "connect-src 'self' wss://*.inboxbondhu.me ws://localhost:* ws://127.0.0.1:*",
    "img-src 'self' https: data:",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ')

  const { pathname } = request.nextUrl
  const hasSession = request.cookies.has('ib_at') || request.cookies.has('ib_rt')
  const isPublic = pathname === '/' || PUBLIC_PATHS.some((p) => pathname.startsWith(p))

  if (!hasSession && !isPublic) {
    const login = request.nextUrl.clone()
    login.pathname = '/login'
    login.searchParams.set('next', pathname)
    return NextResponse.redirect(login)
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  return response
}

export const config = {
  // Never intercept the API proxy, realtime, healthz, or static assets.
  matcher: ['/((?!api|realtime|healthz|_next/static|_next/image|favicon.ico).*)'],
}
