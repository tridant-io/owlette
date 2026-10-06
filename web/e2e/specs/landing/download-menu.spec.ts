/**
 * Landing — the header's download offers every platform: a menu on desktop, a
 * row in the phone menu. Each entry is the public /download permalink for its
 * os, so a signed-out visitor needs nothing more.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const PERMALINKS = ['/download?os=windows', '/download?os=macos', '/download?os=linux'];

test.describe('landing — download', () => {
  test('the desktop header lists a download for each platform', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('banner').getByRole('button', { name: 'download' }).click();

    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveText(['windows', 'macOS (apple silicon)', 'linux (.deb)']);
    for (const [i, href] of PERMALINKS.entries()) {
      await expect(items.nth(i)).toHaveAttribute('href', href);
    }
  });

  test('the phone menu lists them on one row, inside the screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'open menu' }).click();

    const links = PERMALINKS.map((href) => page.locator(`header nav a[href="${href}"]`));
    const tops = new Set<number>();
    for (const link of links) {
      await expect(link).toBeVisible();
      const box = (await link.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      tops.add(Math.round(box.y));
    }
    expect(tops.size).toBe(1);
  });
});

test.describe('docs — footer', () => {
  test('closes the page instead of covering the last of it', async ({ page }) => {
    await page.goto('/docs/agent/installation');

    const footer = page.getByRole('contentinfo').filter({ hasText: 'made with' });
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeInViewport();
    // one frame for both: a pinned footer sat at the viewport's foot, above the article's end
    const { articleBottom, footerTop } = await page.evaluate(() => ({
      articleBottom: document.querySelector('article')!.getBoundingClientRect().bottom,
      footerTop: [...document.querySelectorAll('footer')]
        .find((el) => el.textContent?.includes('made with'))!
        .getBoundingClientRect().top,
    }));
    expect(footerTop).toBeGreaterThanOrEqual(articleBottom - 1);
  });
});
