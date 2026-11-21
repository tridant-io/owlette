/**
 * focus outlines cut off by a box that clips: the admin sidebar's nav scrolls on a
 * short screen, and tabbing scrolled its last link in flush with the edge; the sign-in
 * and sign-up forms reveal their fields in a box that clips, flush with the fields' sides.
 */

import { test, expect } from '@playwright/test';
import { clippedFocusRings } from '../../helpers/focusRing';
import { roleState } from '../../helpers/roles';

test.describe('admin sidebar', () => {
  test.use(roleState('superadmin'));

  test('every nav link keeps its whole focus outline on a short screen', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/admin/users');
    const nav = page.locator('#admin-sidebar nav');
    await expect(nav).toBeVisible({ timeout: 10_000 });
    // the case needs a nav taller than its box
    expect(await nav.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    expect(await clippedFocusRings(page, nav)).toEqual([]);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ['/login', '/register']) {
    test(`${path} keeps every field's whole focus outline once the email form opens`, async ({ page }) => {
      await page.goto(path);
      // focusing email opens the rest of the form
      await page.getByLabel(/^email$/i).click();
      const reveal = page.locator('.form-reveal');
      await expect(reveal).toBeVisible();

      expect(await clippedFocusRings(page, reveal)).toEqual([]);
    });
  }
});
