/**
 * Add machine → generate code: a generated phrase is usable on every platform.
 * Windows gets the /ADD= command; macOS and Linux get the pairing preseed,
 * the only way they can spend a phrase nobody is standing in front of (#322).
 *
 * The device-code endpoints are stubbed so the phrase is fixed. The e2e host is
 * localhost, so neither command names a server; the dev variant is pinned in
 * __tests__/lib/environment.test.ts.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const PHRASE = 'balance-time-loud';

test.beforeAll(async () => {
  // a site with a machine shows the header "+" rather than the getting-started card
  await seedMachine(TEST_SITES[0].id, 'e2e-generate-code');
});

test.describe('add machine generate code — admin', () => {
  test.use(roleState('admin'));

  test('shows the windows command and the macos/linux preseed for the phrase', async ({ page, context }) => {
    await page.route('**/api/agent/auth/device-code', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pairPhrase: PHRASE }) })
    );
    await page.route('**/api/agent/auth/device-code/authorize', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) })
    );
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await page.goto('/dashboard');
    await page.getByRole('button', { name: /add machine/i }).first().click();
    const dialog = page.getByRole('dialog', { name: 'add machine' });
    await dialog.getByRole('button', { name: 'generate code' }).click();
    await dialog.getByRole('button', { name: 'generate code' }).last().click();

    await expect(dialog.getByText('code ready')).toBeVisible();
    await expect(dialog.getByText(new RegExp(`/ADD=${PHRASE} /SILENT$`))).toBeVisible();
    await expect(dialog.getByText(`{"phrase": "${PHRASE}"}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(/pair from the app/)).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: /paths and commands/ })).toHaveAttribute(
      'href',
      '/docs/agent/installation#the-pairing-preseed-macos-and-linux'
    );

    await dialog.getByRole('button', { name: 'copy macos / linux pairing preseed' }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`{"phrase": "${PHRASE}"}`);
  });
});
