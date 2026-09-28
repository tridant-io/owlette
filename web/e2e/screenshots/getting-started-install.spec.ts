/**
 * Docs screenshot — installer download + platform menu + copy-link button
 * cluster, captured from the `dashboard-mixed-states` scenario.
 *
 * Out: `web/public/docs-screens/getting-started-install-buttons.png`
 * Used by: `web/content/docs/getting-started.mdx`
 */
import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../helpers/roles';
import { getAdminDb } from '../helpers/emulator';
import { FIXED_NOW_MS, seedScreenshotFixtures } from './fixtures';
import {
  installFixedClock,
  pinAdminSiteContext,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1440, height: 900 } });

test('getting-started install buttons docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('dashboard-mixed-states');

  try {
    // Pin lastSiteId so /dashboard picks the screenshot site, not baseline site-A.
    await pinAdminSiteContext(ctx.siteId);

    await getAdminDb().collection('installer_metadata').doc('latest').set({
      version: '2.12.3',
      download_url: 'https://owlette.app/download/Owlette-Installer-v2.12.3.exe',
      file_size: 47_185_920,
      release_date: Timestamp.fromMillis(FIXED_NOW_MS),
      release_notes: 'latest release',
    });

    // Clock BEFORE goto so "x minutes ago" text resolves against FIXED_NOW.
    await installFixedClock(page);

    await page.goto('/dashboard');

    await expect(page.getByTestId('machine-card')).toHaveCount(10);
    await expect(page.getByLabel('download owlette agent')).toBeVisible();

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
        }

        [aria-label="download owlette agent"],
        [aria-label="choose installer platform"],
        [aria-label="copy owlette agent download link"] {
          outline: 2px solid #22d3ee !important;
          outline-offset: 3px !important;
          border-radius: 8px !important;
          box-shadow: 0 0 0 4px rgb(34 211 238 / 16%) !important;
        }
      `,
    });

    // Re-pin Date.now() after navigation for hooks that captured it at mount.
    await page.clock.setFixedTime(FIXED_NOW_MS);
    await page.waitForTimeout(500);

    const downloadButton = page.getByLabel('download owlette agent');
    const platformButton = page.getByLabel('choose installer platform');
    const copyButton = page.getByLabel('copy owlette agent download link');
    const header = page.locator('header').first();

    await expect(downloadButton).toBeEnabled();
    await expect(platformButton).toBeVisible();
    await expect(copyButton).toBeVisible();
    await expect(page.getByLabel('help')).toBeVisible();
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();
    await expect(header).toBeVisible();

    const headerBox = await header.boundingBox();
    if (!headerBox) {
      throw new Error('Dashboard header bounding box was unavailable.');
    }

    const cropWidth = Math.min(560, Math.floor(headerBox.width));
    const clipX = Math.floor(headerBox.x + headerBox.width - cropWidth);

    await page.screenshot({
      path: 'public/docs-screens/getting-started-install-buttons.png',
      clip: {
        x: clipX,
        y: Math.floor(headerBox.y),
        width: Math.ceil(headerBox.x + headerBox.width - clipX),
        height: Math.ceil(headerBox.height),
      },
    });
  } finally {
    await ctx.cleanup();
  }
});
