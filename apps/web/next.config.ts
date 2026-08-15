import type { NextConfig } from 'next'

/**
 * The dashboard NEVER talks to the api origin directly from the browser —
 * everything goes through relative /api/* (and /realtime for the socket),
 * proxied here. Cookies stay first-party (SameSite=Strict survives), CORS
 * stays single-origin, and the preview/proxy environment works unchanged.
 */
// next.config runs at build time inside the Next.js process; packages/config
// (server-side Zod loader) cannot be imported into the web bundle. This is
// the ONE web-side env read.
// eslint-disable-next-line no-restricted-properties
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000'

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/healthz', destination: `${API_ORIGIN}/healthz` },
      { source: '/realtime/:path*', destination: `${API_ORIGIN}/realtime/:path*` },
      { source: '/realtime', destination: `${API_ORIGIN}/realtime` },
    ]
  },
  poweredByHeader: false,
  // contracts ships TS source with ESM ".js" import specifiers (tsc rewrites
  // them for Node). Type-only imports erased before webpack ever looked; now
  // that the web imports VALUES (PLAN_LIMITS — the hardcoding-audit fix),
  // webpack must map ".js" → ".ts" for workspace source.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default nextConfig
