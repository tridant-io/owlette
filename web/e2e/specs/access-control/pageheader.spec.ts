/**
 * Access-control — PageHeader (top-bar user menu)
 *
 * Verifies role-conditional chrome on every authenticated page:
 *   - the red "superadmin" Crown pill next to the avatar, visible only for
 *     role === 'superadmin'
 *   - the "admin panel" link inside the user-menu dropdown, visible for
 *     role === 'admin' and role === 'superadmin' (hidden for members), landing
 *     on /admin/sites for admins and /admin/installers for superadmins
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';

async function openUserMenu(page: Page) {
  await page.getByTestId('user-menu-trigger').click();
}

test.describe('PageHeader — member', () => {
  test.use(roleState('member'));

  test('does not show superadmin Crown pill', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toHaveCount(0);
  });

  test('does not show admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toHaveCount(0);
  });
});

test.describe('PageHeader — admin (site-scoped middle tier)', () => {
  test.use(roleState('admin'));

  test('does not show superadmin Crown pill', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toHaveCount(0);
  });

  test('shows admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toBeVisible();
  });

  test('admin panel link lands on /admin/sites', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: /admin panel/i }).click();
    await expect(page).toHaveURL(/\/admin\/sites/, { timeout: 10_000 });
  });
});

test.describe('PageHeader — superadmin (platform god-mode)', () => {
  test.use(roleState('superadmin'));

  test('shows red superadmin Crown pill next to avatar', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByLabel('signed in as superadmin')).toBeVisible();
  });

  test('shows admin panel link in user menu', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await expect(page.getByRole('menuitem', { name: /admin panel/i })).toBeVisible();
  });

  test('admin panel link lands on /admin/installers', async ({ page }) => {
    await page.goto('/dashboard');
    await openUserMenu(page);
    await page.getByRole('menuitem', { name: /admin panel/i }).click();
    await expect(page).toHaveURL(/\/admin\/installers/, { timeout: 10_000 });
  });
});
