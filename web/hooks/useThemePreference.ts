'use client';

/**
 * the user's appearance choice. next-themes owns the live class and the
 * localStorage copy that carries first paint; a signed-in choice is also saved
 * to `users/{uid}.preferences.theme` so it follows the user to other devices,
 * where ThemePreferenceSync applies it.
 */

import { useCallback } from 'react';
import { useTheme } from 'next-themes';
import { useAuth } from '@/contexts/AuthContext';
import { logError } from '@/lib/errorHandler';
import { DEFAULT_THEME, THEMES, type ThemeChoice } from '@/lib/theme';

/**
 * this tab's own theme writes, shared with ThemePreferenceSync so it can tell
 * their firestore echo from a change made on another device. `last` is the
 * value this tab last wrote or adopted. `pending` counts writes in flight:
 * updateUserPreferences re-applies each write's value when it lands, so a
 * quick light then dark reads back light for a moment, and that is no news either.
 */
export const themeWrites: { last?: ThemeChoice; pending: number } = { pending: 0 };

export interface ThemePreference {
  /** what the user picked; 'system' follows the os */
  choice: ThemeChoice;
  /** what is on screen now. dark until next-themes has mounted */
  resolved: 'dark' | 'light';
  /** applies at once, then saves for a signed-in user */
  setChoice: (choice: ThemeChoice) => void;
}

export function useThemePreference(): ThemePreference {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { user, updateUserPreferences } = useAuth();

  const setChoice = useCallback((choice: ThemeChoice) => {
    setTheme(choice);
    if (!user) return;
    themeWrites.last = choice;
    themeWrites.pending += 1;
    updateUserPreferences({ theme: choice }, { silent: true })
      .catch((error: unknown) => logError(error, 'theme-preference-save'))
      .finally(() => { themeWrites.pending -= 1; });
  }, [setTheme, user, updateUserPreferences]);

  return {
    choice: THEMES.find((t) => t === theme) ?? DEFAULT_THEME,
    resolved: resolvedTheme === 'light' ? 'light' : 'dark',
    setChoice,
  };
}
