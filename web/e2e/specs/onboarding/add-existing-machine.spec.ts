/**
 * /add and the dashboard's enter-code tab, with the phrase of a machine already
 * on the site: each names the machine before anything is approved, and pairing
 * it takes the replace confirmation. The authorize route itself refuses an
 * approval that does not name the machine, and leaves the code pending for the
 * confirmed one.
 *
 * Real routes up to the mint: the installer's device code, the preview and the
 * refusal. The confirmed authorize is stubbed, because the mint signs in through
 * Identity Toolkit, which this emulator suite cannot reach.
 */

import { test, expect, type Page, type PlaywrightTestArgs } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const SITE = TEST_SITES[0];
const MACHINE = 'e2e-reinstall-machine';
const pairPhrases: string[] = [];

test.use(roleState('admin'));

test.beforeAll(async () => {
  await seedMachine(SITE.id, MACHINE);
});

test.afterAll(async () => {
  const db = getAdminDb();
  await db.doc(`sites/${SITE.id}/machines/${MACHINE}`).delete();
  for (const phrase of pairPhrases) await db.collection('device_codes').doc(phrase).delete();
});

/** a code for MACHINE, made anonymously as an installer asks: a signed-in caller would get one that names no machine. */
async function installerCode(playwright: PlaywrightTestArgs['playwright']): Promise<string> {
  const installer = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
  const created = await installer.post('/api/agent/auth/device-code', {
    data: { machineId: MACHINE, version: '4.1.28' },
  });
  expect(created.status()).toBe(200);
  const { pairPhrase } = (await created.json()) as { pairPhrase: string };
  await installer.dispose();
  pairPhrases.push(pairPhrase);
  return pairPhrase;
}

/** stubs the confirmed authorize and returns what it was sent. */
async function stubConfirmedAuthorize(page: Page): Promise<() => Record<string, unknown> | undefined> {
  let confirmed: Record<string, unknown> | undefined;
  await page.route('**/api/agent/auth/device-code/authorize', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (!body.replaceMachineId) return route.fallback();
    confirmed = body;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, machineId: MACHINE }),
    });
  });
  return () => confirmed;
}

test('a machine already on the site is named, and pairs only once the replacement is confirmed', async ({
  page,
  playwright,
}) => {
  const pairPhrase = await installerCode(playwright);

  const unconfirmed = await page.request.post('/api/agent/auth/device-code/authorize', {
    data: { pairPhrase, siteId: SITE.id },
  });
  expect(unconfirmed.status()).toBe(409);
  expect(await unconfirmed.json()).toMatchObject({ code: 'machine_exists', machineId: MACHINE });
  const code = await getAdminDb().collection('device_codes').doc(pairPhrase).get();
  expect(code.data()?.status).toBe('pending');

  const confirmed = await stubConfirmedAuthorize(page);

  await page.goto(`/add?code=${pairPhrase}`);
  await expect(page.getByLabel(/pairing phrase/i)).toHaveValue(pairPhrase);
  await expect(page.getByRole('button', { name: /authorize machine/i })).toHaveCount(0);
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByTestId('add-machine-name')).toHaveText(MACHINE);
  const notice = page.getByTestId('replace-machine-notice');
  await expect(notice).toContainText('already on this site');
  await expect(page.getByRole('button', { name: /authorize machine/i })).toHaveCount(0);

  await notice.getByRole('button', { name: 'cancel' }).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: /^continue$/i }).click();

  await notice.getByRole('button', { name: 'replace machine' }).click();
  await expect(page.getByRole('heading', { name: /machine authorized/i })).toBeVisible();
  expect(confirmed()).toEqual({ pairPhrase, siteId: SITE.id, replaceMachineId: MACHINE });
});

test("the dashboard's enter-code tab names the machine, and asks before replacing it", async ({
  page,
  playwright,
}) => {
  const pairPhrase = await installerCode(playwright);
  const confirmed = await stubConfirmedAuthorize(page);

  await page.goto('/dashboard');
  await page.getByRole('button', { name: /add machine/i }).first().click();
  const dialog = page.getByRole('dialog', { name: 'add machine' });
  await dialog.getByPlaceholder('e.g., silver-compass-drift').fill(pairPhrase);
  await expect(dialog.getByRole('button', { name: /authorize machine/i })).toHaveCount(0);
  await dialog.getByRole('button', { name: /^continue$/i }).click();

  await expect(dialog.getByTestId('add-machine-name')).toHaveText(MACHINE);
  const notice = dialog.getByTestId('replace-machine-notice');
  await expect(notice).toContainText('already on this site');

  await notice.getByRole('button', { name: 'replace machine' }).click();
  await expect(dialog.getByText('machine authorized')).toBeVisible();
  expect(confirmed()).toEqual({ pairPhrase, siteId: SITE.id, replaceMachineId: MACHINE });
});
