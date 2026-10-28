/**
 * /logs crash-screenshot viewer by keyboard. Escape was bound to the overlay
 * <div>, which never receives focus, so it never fired: a keyboard user had to
 * find the close button, and focus was left behind on the page underneath.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { seedLogEvents } from '../../helpers/coverageSeed';

test.use(roleState('superadmin'));

test.beforeEach(async () => {
  await seedLogEvents('site-A');
});

test('escape closes the screenshot viewer and focus returns to the thumbnail', async ({ page }) => {
  await page.goto('/logs');
  await expect(page.getByRole('heading', { level: 1, name: /^logs$/i })).toBeVisible();

  const siteSwitcher = page.getByTestId('site-switcher-trigger');
  await expect(siteSwitcher).toBeVisible();
  if (!((await siteSwitcher.textContent()) ?? '').includes('Site A')) {
    await siteSwitcher.click();
    await page.getByRole('menuitem', { name: /Site A \(Assigned\)/ }).click();
    await expect(siteSwitcher).toContainText('Site A');
  }

  await page.getByTestId('log-row-e2e-log-crash').click();
  const thumbnail = page.getByRole('button', { name: 'crash screenshot' });
  await thumbnail.focus();
  await page.keyboard.press('Enter');

  const viewer = page.getByRole('dialog', { name: 'crash screenshot' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'close screenshot' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});
