/**
 * Mobile — the admin drawer by keyboard. Viewport / isMobile / hasTouch come
 * from the `mobile-chromium` project, which owns every spec under specs/mobile/**.
 *
 * Below lg the admin nav is an off-canvas drawer. It used to stay in the tab
 * order while translated off-screen, had no escape, and left focus wherever it
 * was; its open button had no name at all.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';

test.use(roleState('admin'));

test('the admin drawer opens into focus, closes on escape and returns focus', async ({ page }) => {
  await page.goto('/admin/members');
  await expect(page.getByRole('heading', { level: 1, name: 'members', exact: true })).toBeVisible({
    timeout: 10_000,
  });

  const open = page.getByRole('button', { name: 'open admin menu' });
  const close = page.getByRole('button', { name: 'close admin menu' });
  // closed: the drawer's controls are out of the accessibility tree and the tab order
  await expect(close).toBeHidden();
  await expect(page.getByRole('link', { name: /members/ })).toHaveCount(0);

  await open.focus();
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await expect(page.getByRole('link', { name: /members/ })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press('Escape');
  await expect(close).toBeHidden();
  await expect(open).toBeFocused();
});
