/**
 * the appearance an operator can pick, in menu order. 'system' leaves the window
 * theme to the os; 'dark' and 'light' pin it. mirrors `ThemeChoice` in
 * `src-tauri/src/window_state.rs`, which stores it and applies it to the window.
 */
export const THEMES = ['system', 'dark', 'light'] as const

export type ThemeChoice = (typeof THEMES)[number]

/** the host's answer before anything is stored */
export const DEFAULT_THEME: ThemeChoice = 'system'

/** what the page draws: the choice, with `system` resolved against the os by the host */
export type ResolvedTheme = 'dark' | 'light'

/** drawn when the host can't be asked (a browser dev run), as `<html class="dark">` */
export const FALLBACK_THEME: ResolvedTheme = 'dark'
