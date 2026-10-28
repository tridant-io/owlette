/**
 * the theme a user can pick. 'system' follows the os through
 * `prefers-color-scheme`; next-themes resolves it to 'dark' or 'light'.
 */
export const THEMES = ['system', 'dark', 'light'] as const;

export type ThemeChoice = (typeof THEMES)[number];

export const DEFAULT_THEME: ThemeChoice = 'system';

/**
 * the class the server renders on <html>, and so the theme whenever there is
 * no signal: no js, or a head script that failed or was blocked.
 */
export const FALLBACK_THEME = 'dark';

/** the localStorage key next-themes reads before first paint */
export const THEME_STORAGE_KEY = 'owlette_theme';
