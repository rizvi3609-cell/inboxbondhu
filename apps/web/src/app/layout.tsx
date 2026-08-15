import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { Inter, Noto_Sans_Bengali } from 'next/font/google'
import { headers } from 'next/headers'
import './globals.css'

// Self-hosted variable fonts (spec §3.3) — next/font subsets + preloads,
// zero external requests (CSP + BD network reality).
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})
const bengali = Noto_Sans_Bengali({
  subsets: ['bengali'],
  weight: 'variable',
  variable: '--font-bengali',
  display: 'swap',
  preload: false, // loads when Bengali text renders; UI chrome is Latin
})

export const metadata: Metadata = {
  title: { default: 'InboxBondhu', template: '%s · InboxBondhu' },
  description: 'AI social-commerce inbox for Bangladeshi Facebook & Instagram sellers',
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8f7f4' },
    { media: '(prefers-color-scheme: dark)', color: '#12110f' },
  ],
}

/**
 * Theme boot: reads the stored preference BEFORE first paint (no FOUC).
 * Runs inline with the CSP nonce the middleware issued (spec C-5).
 */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem('ib-theme');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.setAttribute('data-theme','dark')}}catch(e){}})()`

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className={`${inter.variable} ${bengali.variable}`}>{children}</body>
    </html>
  )
}
