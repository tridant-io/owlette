/**
 * Mobile — menus and inputs at 390px (viewport / isMobile / hasTouch come from
 * the `mobile-chromium` project in playwright.config.ts).
 *
 * The app's nav drawer behaves as the modal it looks like: focus moves in, tab
 * stays in, escape hands focus back to the menu button. The current site stays
 * named in the bar, where the breadcrumb that names it on desktop is hidden. The
 * landing menu's links take no tab stop while it is closed. And the hoot
 * composer types at 16px, below which iOS zooms the page into the field.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_USERS } from '../../helpers/seed';
import { seedHootFixture } from '../../helpers/coverageSeed';

test.describe('app nav drawer', () => {
  test.use(roleState('admin'));

  test('the bar names the current site beside the menu button', async ({ page }) => {
    await page.goto('/dashboard');

    const site = page.getByTestId('mobile-current-site');
    await expect(site).toBeVisible();
    await expect(site).not.toBeEmpty();
  });

  test('focus moves in, tab stays in, and escape hands it back', async ({ page }) => {
    await page.goto('/dashboard');

    const trigger = page.getByRole('button', { name: 'menu', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog', { name: 'menu' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'close menu' })).toBeFocused();

    // backwards off the first control wraps to the last, not out to the page.
    await page.keyboard.press('Shift+Tab');
    expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe('landing menu', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('its links take no tab stop while the menu is closed', async ({ page }) => {
    await page.goto('/');

    const toggle = page.getByRole('button', { name: 'open menu' });
    await toggle.focus();
    await page.keyboard.press('Tab');
    // the closed panel follows the toggle in the dom; tab must skip past it.
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('header')))).toBe(false);

    await toggle.click();
    await expect(page.getByRole('link', { name: 'pricing', exact: true })).toBeVisible();
  });
});

test.describe('hoot composer', () => {
  test.use(roleState('admin'));

  test('types at 16px so iOS does not zoom into it', async ({ page }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');

    const composer = page.getByLabel('chat message');
    await expect(composer).toBeVisible();
    await expect(composer).toHaveCSS('font-size', '16px');
  });
});
