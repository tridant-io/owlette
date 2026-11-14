import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedCliDeviceCode } from '../../helpers/coverageSeed';

test.describe('legacy setup route', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('unauthenticated visitors are sent to login before setup redirect can run', async ({ page }) => {
    await page.goto('/setup?code=silver-compass-drift');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsetup/, { timeout: 10_000 });
  });
});

test.describe('add machine pairing', () => {
  test.use(roleState('member'));

  test('legacy setup redirects authenticated users to /add with query params preserved', async ({ page }) => {
    await page.goto('/setup?code=silver-compass-drift');
    await expect(page).toHaveURL(/\/add\?code=silver-compass-drift/, { timeout: 10_000 });
  });

  test('prefills code from query and completes the authorize flow with a stubbed agent API', async ({ page }) => {
    await page.route('**/api/agent/auth/device-code/authorize', async (route) => {
      const { preview } = route.request().postDataJSON() as { preview?: boolean };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          preview
            ? { machineId: 'e2e-paired-machine', existing: false }
            : { success: true, machineId: 'e2e-paired-machine' },
        ),
      });
    });

    await page.goto('/add?code=silver-compass-drift');
    await expect(page.getByText('add machine').first()).toBeVisible();
    await expect(page.getByLabel(/pairing phrase/i)).toHaveValue('silver-compass-drift');

    // the machine is named before anything is approved
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByTestId('add-machine-name')).toHaveText('e2e-paired-machine');
    await page.getByRole('button', { name: /authorize machine/i }).click();
    await expect(page.getByRole('heading', { name: /machine authorized/i })).toBeVisible();
    await expect(page.getByText(/e2e-paired-machine/)).toBeVisible();
  });
});

test.describe('CLI device authorization', () => {
  test.use(roleState('member'));

  test('authorizes a pending device code and the polling client receives the raw key once', async ({ page, request }) => {
    const code = 'silver-compass-drift';
    const deviceCode = await seedCliDeviceCode(code, 'e2e-cli-device-code');

    await page.goto(`/cli/authorize?code=${code}`);
    await expect(page.getByRole('heading', { name: /authorise cli/i })).toBeVisible();
    await page.getByLabel(/key name/i).fill('e2e cli');
    await page.getByLabel(/ttl \(days\)/i).fill('7');
    await page.getByRole('button', { name: /^authorise$/i }).click();
    await expect(page.getByText('cli authorised', { exact: true })).toBeVisible();

    const db = getAdminDb();
    const handoff = await db.collection('cli_device_codes').doc(code).get();
    expect(handoff.data()?.status).toBe('authorized');
    expect(handoff.data()?.rawKey).toMatch(/^owk_live_/);

    const poll = await request.post('/api/cli/device-code/poll', {
      data: { deviceCode },
    });
    expect(poll.status()).toBe(200);
    const body = await poll.json();
    expect(body.apiKey).toMatch(/^owk_live_/);
    expect(body.name).toBe('e2e cli');

    const secondPoll = await request.post('/api/cli/device-code/poll', {
      data: { deviceCode },
    });
    expect(secondPoll.status()).toBe(404);
  });
});
