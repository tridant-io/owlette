/**
 * Screenshot for the landing page's diagnose capability card.
 * Output: `web/public/landing-screens/preview-diagnose.png`
 *
 * Uses the `diagnose-cortex-chat` scenario — a seeded incident Q&A against
 * `media-server-stage`, plus the LLM-key bypass so hoot renders the chat rather
 * than the no-key gate.
 *
 * Hoot takes no conversation id via URL params, so the seeded conversation is
 * opened by clicking its (deterministic) sidebar title.
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { TEST_USERS } from '../helpers/seed';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import { test, themedPath } from './docs-helpers';

test.use(roleState('admin'));

test('diagnose capability card preview', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('diagnose-cortex-chat');

  try {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set({ lastSiteId: ctx.siteId }, { merge: true });

    // Pin the clock BEFORE goto or the sidebar's "x ago" stamps drift.
    await page.clock.install({ time: FIXED_NOW_MS });

    await page.goto('/hoot');

    const conversationItem = page
      .getByText('03:14 incident — media-server-stage', { exact: false })
      .first();
    await expect(conversationItem).toBeVisible();
    await conversationItem.click();

    // The persisted message load is async — capture only once it has rendered.
    await expect(
      page.getByText('access violation', { exact: false })
    ).toBeVisible();

    // dashboard has persistent firestore websockets — network never idles. wait for paint instead.
    await page.waitForTimeout(1500);

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

    await page.clock.setFixedTime(FIXED_NOW_MS);

    // Markdown messages mount a frame after the chat doc resolves.
    await page.waitForTimeout(500);

    await page.screenshot({
      path: themedPath('public/landing-screens/preview-diagnose.png'),
      fullPage: false,
    });
  } finally {
    await ctx.cleanup();
  }
});
