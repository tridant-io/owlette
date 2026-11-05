/**
 * Every screenshot is captured once per theme, by a playwright project named
 * for it (`playwright.screenshots.config.ts`, `playwright.desktop-screenshots.config.ts`).
 * The light capture sits next to the dark one as `<name>-light.png`;
 * `scripts/refresh-docs-screens.mjs --check` holds the pairs together.
 */

import { test } from '@playwright/test';

export type ShotTheme = 'dark' | 'light';

/** The theme of the running project. */
export function projectTheme(): ShotTheme {
  return test.info().project.name === 'light' ? 'light' : 'dark';
}

/** `x.png` in dark, `x-light.png` in light. */
export function themedPath(path: string, theme: ShotTheme = projectTheme()): string {
  return theme === 'light' ? path.replace(/\.png$/, '-light.png') : path;
}
