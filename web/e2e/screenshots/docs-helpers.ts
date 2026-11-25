import { mkdir } from 'node:fs/promises';
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { THEME_STORAGE_KEY } from '@/lib/theme';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS } from './fixtures';
import { projectTheme, themedPath } from './themes';

export { themedPath };

const DOCS_SCREENSHOT_DIR = 'public/docs-screens';

/**
 * The screenshot specs' `test`: every page opens in the project's theme. The
 * stored choice is what next-themes paints first, as for a returning visitor;
 * `pinAdminSiteContext` saves the same choice on the user doc, so the sync
 * after sign-in agrees with it.
 */
export const test = base.extend<{ pinTheme: void }>({
  pinTheme: [
    async ({ context }, use) => {
      await context.addInitScript(
        ([key, theme]) => {
          // top frame only, and an opaque origin (about:blank) has no storage
          if (window.self !== window.top) return;
          try {
            window.localStorage.setItem(key, theme);
          } catch {
            // nothing to pin on a page that has no storage
          }
        },
        [THEME_STORAGE_KEY, projectTheme()] as const,
      );
      await use();
    },
    { auto: true },
  ],
});

export async function pinAdminSiteContext(siteId: string): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set(
      {
        sites: [siteId],
        lastSiteId: siteId,
        preferences: {
          statsExpanded: true,
          processesExpanded: true,
          displaysExpanded: true,
          activeGraphPanel: null,
          timeDisplayMode: 'site',
          timeFormat: '12h',
          timezone: 'America/Los_Angeles',
          theme: projectTheme(),
        },
      },
      { merge: true },
    );
}

export async function installFixedClock(page: Page): Promise<void> {
  await page.clock.install({ time: FIXED_NOW_MS });
}

export async function disableAnimations(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `,
  });
}

export async function settleForDocsScreenshot(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  await disableAnimations(page);
  await page.clock.setFixedTime(FIXED_NOW_MS);
  await page.waitForTimeout(500);
}

export async function saveDocsScreenshot(
  target: Locator,
  filename: string,
): Promise<void> {
  await mkdir(DOCS_SCREENSHOT_DIR, { recursive: true });
  await expect(target).toBeVisible();
  await target.screenshot({
    path: themedPath(`${DOCS_SCREENSHOT_DIR}/${filename}`),
  });
}
