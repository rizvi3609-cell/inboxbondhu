'use client'

import { useEffect, useState } from 'react'

function currentTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  useEffect(() => setTheme(currentTheme()), [])

  function toggle() {
    const next = theme === 'dark' ? 'light' : 'dark'
    const root = document.documentElement
    root.classList.add('theme-transition') // crossfade, not a flash
    if (next === 'dark') root.setAttribute('data-theme', 'dark')
    else root.removeAttribute('data-theme')
    try {
      localStorage.setItem('ib-theme', next)
    } catch {
      /* private mode */
    }
    setTheme(next)
    window.setTimeout(() => root.classList.remove('theme-transition'), 250)
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      style={{
        border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
        borderRadius: 'var(--radius-sm)', width: 32, height: 32, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 15,
        transition: 'transform var(--dur-fast) ease',
      }}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  )
}
