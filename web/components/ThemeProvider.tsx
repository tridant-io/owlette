'use client';

import type { ReactNode } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { DEFAULT_THEME, THEME_STORAGE_KEY } from '@/lib/theme';

// 'system' is left out: next-themes adds it with enableSystem. module scope
// keeps the array identity stable, since next-themes memoises its context on it
const RESOLVED_THEMES = ['dark', 'light'];

/**
 * owns the theme class on <html>. the nonce is the per-request csp nonce: the
 * head script that sets the class before first paint is blocked without it.
 */
export function ThemeProvider({ nonce, children }: { nonce?: string; children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      themes={RESOLVED_THEMES}
      defaultTheme={DEFAULT_THEME}
      enableSystem
      enableColorScheme
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
