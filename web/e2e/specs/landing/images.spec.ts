/**
 * Landing — image loading. The dashboard screenshot is the page's largest
 * contentful paint, so it alone is preloaded, fetched at high priority, and
 * served through the image optimizer at a width that matches its slot. The
 * capability previews sit in collapsed panels and must not compete with it.
 * Public page, so no storage state.
 */

import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const imagePreloads = (page: Page, file: string) =>
  page.locator(`link[rel="preload"][as="image"][imagesrcset*="${file}"]`);

test.describe('landing — images', () => {
  test('the dashboard screenshot is optimized, sized, and fetched first', async ({ page }) => {
    await page.goto('/');

    const hero = page.getByAltText(/owlette dashboard showing/i);
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute('src', /\/_next\/image\?/);
    await expect(hero).toHaveAttribute('sizes', '(max-width: 1200px) 100vw, 1152px');
    await expect(hero).toHaveAttribute('fetchpriority', 'high');
    await expect(hero).not.toHaveAttribute('loading', 'lazy');
    await expect(imagePreloads(page, 'dashboard.png')).toHaveCount(1);
  });

  test('the capability previews wait to be needed', async ({ page }) => {
    await page.goto('/');

    // the accordion and the grid each render all six; none may be preloaded.
    const previews = page.getByAltText(/ preview$/);
    await expect(previews.first()).toBeAttached();
    for (const preview of await previews.all()) {
      await expect(preview).toHaveAttribute('loading', 'lazy');
      await expect(preview).toHaveAttribute('src', /\/_next\/image\?/);
    }
    for (const file of ['monitor.png', 'control.png', 'preview-']) {
      await expect(imagePreloads(page, file)).toHaveCount(0);
    }
  });
});
