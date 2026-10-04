/**
 * Screenshot - docs machine detail view.
 *
 * Output: `web/public/docs-screens/machine-detail.png`
 * Used by: `web/content/docs/dashboard/machine-monitoring.mdx`
 */
import { expect } from '@playwright/test';
import { roleState } from '../helpers/roles';
import { seedScreenshotFixtures } from './fixtures';
import {
  installFixedClock,
  pinAdminSiteContext,
  settleForDocsScreenshot,
  test,
  themedPath,
} from './docs-helpers';

test.use({ ...roleState('admin'), viewport: { width: 1100, height: 900 } });

test('machine detail docs screenshot', async ({ page }) => {
  const ctx = await seedScreenshotFixtures('monitor-single-machine');

  try {
    await pinAdminSiteContext(ctx.siteId);
    await installFixedClock(page);

    await page.goto('/dashboard');

    await expect(page.getByTestId('machine-card')).toHaveCount(4);
    const card = page
      .getByTestId('machine-card')
      .filter({ hasText: ctx.machineId! })
      .first();
    await expect(card).toBeVisible();

    await card.getByText('cpu', { exact: true }).first().click();

    // MetricsDetailPanel is the only shadcn Card on /dashboard that is not a
    // machine card and holds a recharts chart. Identify it structurally rather
    // than by theme classes: the panel's background token moved bg-card ->
    // bg-card-sunken in fcb7c1b2, which silently broke the old class-matching
    // xpath. Machine cards also render recharts sparklines, so `.first()` on a
    // bare `.recharts-surface` can latch onto a card before the panel mounts.
    const panel = page
      .locator('div[data-slot="card"]:not([data-testid="machine-card"])')
      .filter({ has: page.locator('.recharts-surface') })
      .first();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.recharts-surface').first()).toBeVisible();
    await expect(panel).toContainText(ctx.machineId!);

    await panel.getByRole('button', { name: /ram/i }).click();
    await panel.locator('button[title^="C:"]').first().click();
    await panel.getByRole('button', { name: /^gpu$/i }).click();

    await expect(panel).toContainText(/cpu/i);
    await expect(panel).toContainText(/ram/i);
    await expect(panel).toContainText('C:');
    await expect(panel).toContainText(/gpu/i);
    await expect(panel).not.toContainText(/bienvenue/i);

    await settleForDocsScreenshot(page);
    await panel.screenshot({ path: themedPath('public/docs-screens/machine-detail.png') });
  } finally {
    await ctx.cleanup();
  }
});
