/**
 * Account — the appearance preference (light mode, task 5.1).
 *
 * The app follows the OS colour scheme until the user chooses, and dark is the
 * fallback when there is no signal (the server renders `<html class="dark">`).
 * The choice lives in profile → preferences and syncs to
 * `users/{uid}.preferences.theme`.
 *
 * The playwright config pins `colorScheme: 'dark'`, so each test sets the scheme
 * it means. Runs as `owner`, whom no other spec reads preferences for, and
 * clears the stored theme after each test so warm-emulator runs don't drift.
 * Each test gets a fresh context, so nothing carries over in local storage.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

const OWNER = TEST_USERS.owner;
const userDoc = () => getAdminDb().collection('users').doc(OWNER.uid);

/** the resolved theme as the page shows it */
async function htmlTheme(page: Page): Promise<'dark' | 'light' | 'none'> {
  return page.evaluate(() => {
    const list = document.documentElement.classList;
    return list.contains('dark') ? 'dark' : list.contains('light') ? 'light' : 'none';
  });
}

async function openAppearance(page: Page) {
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page.getByRole('button', { name: /^preferences$/i }).first().click();
  return page.getByRole('radiogroup', { name: 'appearance' });
}

test.describe('signed in', () => {
  test.use(roleState('owner'));

  test.afterEach(async () => {
    await userDoc().set({ preferences: { theme: FieldValue.delete() } }, { merge: true });
  });

  test('choosing light in the profile themes the page and saves the choice', async ({ page }) => {
    await page.goto('/dashboard');
    const appearance = await openAppearance(page);

    await appearance.getByRole('radio', { name: 'light' }).click();

    await expect.poll(() => htmlTheme(page)).toBe('light');
    await expect(appearance.getByRole('radio', { name: 'light' })).toHaveAttribute('aria-checked', 'true');
    // the real contract: the choice is on the user, not only in this browser
    await expect.poll(async () => (await userDoc().get()).data()?.preferences?.theme).toBe('light');
  });

  test('a stored choice is on <html> before the app hydrates, so there is no flash', async ({ page }) => {
    await page.goto('/dashboard');
    await (await openAppearance(page)).getByRole('radio', { name: 'light' }).click();
    await expect.poll(() => htmlTheme(page)).toBe('light');

    // record the class at DOMContentLoaded, before react has run
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __themeAtDcl: string }).__themeAtDcl = document.documentElement.className;
      });
    });
    await page.reload();
    const atDcl = await page.evaluate(() => (window as unknown as { __themeAtDcl?: string }).__themeAtDcl ?? '');
    expect(atDcl.split(' ')).toContain('light');
    expect(atDcl.split(' ')).not.toContain('dark');
  });

  test('a choice saved on the account reaches a fresh browser and stays put', async ({ page }) => {
    await userDoc().set({ preferences: { theme: 'light' } }, { merge: true });
    // a dark os and nothing in local storage: only the account says light
    await page.goto('/dashboard');

    await expect.poll(() => htmlTheme(page)).toBe('light');
    // no ping-pong between the device and the account
    await page.waitForTimeout(5_000);
    expect(await htmlTheme(page)).toBe('light');
  });

  test('with no choice, a signed-in user follows the os, live', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/dashboard');
    await expect.poll(() => htmlTheme(page)).toBe('light');

    const appearance = await openAppearance(page);
    await expect(appearance.getByRole('radio', { name: 'system' })).toHaveAttribute('aria-checked', 'true');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => htmlTheme(page)).toBe('dark');
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const colorScheme of ['dark', 'light'] as const) {
    test(`follows a ${colorScheme} os`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await expect.poll(() => htmlTheme(page)).toBe(colorScheme);
    });
  }

  test.describe('without javascript', () => {
    test.use({ javaScriptEnabled: false, colorScheme: 'light' });

    test('the page is dark, whatever the os says', async ({ page }) => {
      await page.goto('/login');
      expect(await htmlTheme(page)).toBe('dark');
    });
  });
});
