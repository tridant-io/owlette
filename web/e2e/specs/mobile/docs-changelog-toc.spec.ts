/**
 * Mobile — the changelog's "on this page" dropdown. Viewport / isMobile /
 * hasTouch come from the `mobile-chromium` project.
 *
 * The changelog has ~470 headings, and fumadocs' toc measures its svg track
 * once per item along the whole path, so a dropdown of every heading froze a
 * phone for 30s on tap. The page sets `tocDepth: 2`: it lists the releases.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('the changelog dropdown lists the releases, opens at once and jumps to one', async ({ page }) => {
  await page.goto('/docs/changelog');
  const releases = await page.locator('#nd-page h2[id]').count();
  expect(releases).toBeGreaterThan(10);

  const trigger = page.locator('[data-toc-popover-trigger]');
  const links = page.locator('[data-toc-popover-content] a[href^="#"]');
  const started = Date.now();
  await trigger.tap();
  await expect(links).toHaveCount(releases);
  // every heading listed took ~10s here unthrottled; the releases take ~0.1s,
  // so the bound is generous for a slow runner and still fails the old list
  expect(Date.now() - started).toBeLessThan(5_000);

  const release = links.nth(1);
  const hash = await release.getAttribute('href');
  await release.tap();
  await expect.poll(() => new URL(page.url()).hash).toBe(hash);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
