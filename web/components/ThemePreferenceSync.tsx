'use client';

import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import { useAuth } from '@/contexts/AuthContext';
import { themeWrites } from '@/hooks/useThemePreference';

/**
 * applies the appearance saved on the user doc, so a choice made on one device
 * reaches the others. the browser's own copy has already painted by then; this
 * only corrects it. renders nothing.
 */
export function ThemePreferenceSync() {
  const { theme, setTheme } = useTheme();
  const { userPreferences } = useAuth();
  const saved = userPreferences.theme;

  useEffect(() => {
    if (!saved || saved === themeWrites.last || themeWrites.pending > 0) return;
    // recorded even when it already matches: a theme changed later in another
    // tab (next-themes syncs those through storage) must not be dragged back here
    themeWrites.last = saved;
    if (saved !== theme) setTheme(saved);
  }, [saved, theme, setTheme]);

  return null;
}
