/**
 * /add's success screen when the machine asked for hoot at pairing: a site
 * admin is offered the allow card for it, and a code without the ask keeps the
 * plain screen. The confirmed authorize is stubbed (the mint signs in through
 * Identity Toolkit, which this emulator suite cannot reach), and the machine is
 * seeded at that moment, as the mint would have made it.
 */

import { test, expect, type Page, type PlaywrightTestArgs } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const SITE = TEST_SITES[0];
const MACHINE = 'e2e-hoot-offer-machine';
const pairPhrases: string[] = [];

test.use(roleState('admin'));

// each test pairs a machine the site does not have yet
test.beforeEach(async () => {
  await getAdminDb().doc(`sites/${SITE.id}/machines/${MACHINE}`).delete();
});

test.afterAll(async () => {
  const db = getAdminDb();
  await db.doc(`sites/${SITE.id}/machines/${MACHINE}`).delete();
  await db.doc(`sites/${SITE.id}/settings/fleet`).delete();
  for (const phrase of pairPhrases) await db.collection('device_codes').doc(phrase).delete();
});

/** a code made anonymously as an installer asks, with or without the hoot ask. */
async function installerCode(playwright: PlaywrightTestArgs['playwright'], wantsHoot: boolean): Promise<string> {
  const installer = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const created = await installer.post('/api/agent/auth/device-code', {
    data: { machineId: MACHINE, version: '4.2.2', ...(wantsHoot ? { wantsHoot: true } : {}) },
  });
  expect(created.status()).toBe(200);
  const { pairPhrase } = (await created.json()) as { pairPhrase: string };
  await installer.dispose();
  pairPhrases.push(pairPhrase);
  return pairPhrase;
}

/** the confirmed authorize answers as the route does: the machine, and the ask if the code carried one. */
async function stubAuthorize(page: Page, wantsHoot: boolean) {
  await page.route('**/api/agent/auth/device-code/authorize', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.preview) return route.fallback();
    await seedMachine(SITE.id, MACHINE);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, machineId: MACHINE, ...(wantsHoot ? { wantsHoot: true } : {}) }),
    });
  });
}

async function pair(page: Page, pairPhrase: string) {
  await page.goto(`/add?code=${pairPhrase}`);
  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page.getByTestId('add-machine-name')).toHaveText(MACHINE);
  await page.getByRole('button', { name: /authorize machine/i }).click();
  await expect(page.getByRole('heading', { name: /machine authorized/i })).toBeVisible();
}

test('a machine that asked for hoot offers the site admin the allow card', async ({ page, playwright }) => {
  const pairPhrase = await installerCode(playwright, true);
  const stored = await getAdminDb().collection('device_codes').doc(pairPhrase).get();
  expect(stored.data()?.wantsHoot).toBe(true);
  await stubAuthorize(page, true);

  await pair(page, pairPhrase);
  await expect(page.getByText(`${MACHINE} asked to let ai tools on it use hoot.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'go to dashboard' })).toHaveCount(0);

  await page.getByRole('button', { name: 'allow it to use hoot' }).click();
  await page.waitForURL((url) => url.pathname === '/admin/hoot' && url.searchParams.get('machine') === MACHINE && url.searchParams.get('site') === SITE.id);
  await expect(page.getByTestId('allow-machine-card')).toBeVisible();
});

test('declining the offer goes to the dashboard', async ({ page, playwright }) => {
  const pairPhrase = await installerCode(playwright, true);
  await stubAuthorize(page, true);

  await pair(page, pairPhrase);
  await page.getByRole('button', { name: 'not now' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});

test('a code without the ask keeps the plain screen', async ({ page, playwright }) => {
  const pairPhrase = await installerCode(playwright, false);
  const stored = await getAdminDb().collection('device_codes').doc(pairPhrase).get();
  expect(stored.data()?.wantsHoot).toBeUndefined();
  await stubAuthorize(page, false);

  await pair(page, pairPhrase);
  await expect(page.getByRole('button', { name: 'go to dashboard' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'allow it to use hoot' })).toHaveCount(0);
});
