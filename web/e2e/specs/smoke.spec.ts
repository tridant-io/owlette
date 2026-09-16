/**
 * Smoke tests — one per role. Passing means the scaffolding works end to end:
 * emulators up, dev server up, global-setup seeded and captured storageState,
 * and a pre-authenticated context reaches /dashboard without bouncing to
 * /login or /setup-2fa. Deeper assertions belong in the per-surface specs.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../helpers/roles';

test.describe('smoke — member', () => {
  test.use(roleState('member'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe('smoke — admin', () => {
  test.use(roleState('admin'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

test.describe('smoke — superadmin', () => {
  test.use(roleState('superadmin'));

  test('lands on /dashboard after authenticated navigation', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('can reach /admin/users', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/users/);
    // Heading-scoped: "user management" is also in the sidebar. 10s because
    // RequireAdminAccess's "verifying permissions..." gate can outlast the 5s
    // default on cold-start runs.
    await expect(
      page.getByRole('heading', { name: 'user management' }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
