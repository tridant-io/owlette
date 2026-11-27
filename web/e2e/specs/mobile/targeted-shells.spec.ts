import { test, expect } from '@playwright/test';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_USERS, seedMachine } from '../../helpers/seed';
import {
  seedHootFixture,
  seedLogEvents,
  seedSystemPreset,
} from '../../helpers/coverageSeed';

test.describe('mobile authenticated shells', () => {
  // Viewport / isMobile / hasTouch come from the `mobile-chromium` project in
  // playwright.config.ts, which owns every spec under specs/mobile/**.
  test.use(roleState('admin'));

  test('dashboard list controls render without clipping', async ({ page }) => {
    await seedMachine('site-A', 'e2e-mobile-machine');
    await page.goto('/dashboard');
    await expect(page.getByText('e2e-mobile-machine')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('logs mobile filters and rows render', async ({ page }) => {
    await seedLogEvents('site-A');
    await page.goto('/logs');
    await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
    await page.getByRole('button', { name: /show filters/i }).click();
    await expect(page.getByTestId('logs-filter-level')).toBeVisible();
    await expect(page.getByText('TouchDesigner', { exact: true }).first()).toBeVisible();
    // The filter panel is only mounted in this state — responsive-acceptance
    // measures /logs with the filters closed, so this is the open-panel width.
    await assertNoHorizontalOverflow(page);
  });

  test('hoot mobile target selector and input render', async ({ page }) => {
    await seedHootFixture({ userId: TEST_USERS.admin.uid });
    await page.goto('/hoot');
    await expect(page.getByLabel(/hoot target/i)).toBeVisible();
    await expect(page.getByLabel('chat message')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});

test.describe('mobile superadmin shells', () => {
  test.use(roleState('superadmin'));

  test('admin sidebar route and presets mobile cards render', async ({ page }) => {
    await seedSystemPreset('e2e-mobile-system-preset', { name: 'E2E Mobile Template' });
    await page.goto('/admin/presets');
    await expect(page.getByRole('heading', { name: /template library/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /edit E2E Mobile Template/i }).first()).toBeVisible();
    // /admin/presets is not in responsive-acceptance's route list — this is the
    // only overflow assertion covering it.
    await assertNoHorizontalOverflow(page);
  });

  // super-uid holds no member row, so every site's dashboard carries the hint (adr 0021)
  test("the member lock's hint fits a phone", async ({ page }) => {
    await page.goto('/dashboard');
    const lock = page.getByTestId('member-lock');
    await expect(lock).toContainText('add yourself to this site to change it');
    await expectFullyWithinViewport(page, lock.getByRole('link', { name: 'add yourself' }), 'add yourself');
    await assertNoHorizontalOverflow(page);
  });
});
