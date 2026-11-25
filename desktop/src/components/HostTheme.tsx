import { useEffect, useState, type ReactNode } from 'react'
import { ThemeProvider } from 'next-themes'
import { onResolvedAppearance } from '@/lib/ipc'
import type { ResolvedTheme } from '@/lib/theme'

/**
 * the host owns the appearance: it stores the choice, resolves `system` against
 * the os, and tells the page which theme to draw. the page can't work it out from
 * `prefers-color-scheme` (webview2 keeps the colour scheme it was created with),
 * so next-themes is forced to the host's answer.
 */
export function HostTheme({ initial, children }: { initial: ResolvedTheme; children: ReactNode }) {
  const [theme, setTheme] = useState(initial)

  useEffect(() => {
    const unlisten = onResolvedAppearance(setTheme)
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  return (
    <ThemeProvider attribute="class" forcedTheme={theme} enableColorScheme disableTransitionOnChange>
      {children}
    </ThemeProvider>
  )
}
