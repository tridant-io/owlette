/**
 * Settings — api keys list: empty state, create dialog (publisher preset +
 * custom ttl), the one-time reveal card, copy, dismiss, and the one-time
 * contract (the raw key never resurfaces in the row or after a reload). Also
 * the create dialog nested over account settings: escape and its overlay
 * close only the inner dialog.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_USERS } from '../../helpers/seed';

test.use(roleState('admin'));

const ADMIN_UID = TEST_USERS.admin.uid;

async function clearApiKeys() {
  const db = getAdminDb();
  const userKeysSnap = await db
    .collection('users')
    .doc(ADMIN_UID)
    .collection('api_keys')
    .get();
  await Promise.all(userKeysSnap.docs.map((d) => d.ref.delete()));
  const lookupSnap = await db
    .collection('api_keys')
    .where('userId', '==', ADMIN_UID)
    .get();
  await Promise.all(lookupSnap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await clearApiKeys();
});

test.afterEach(async () => {
  await clearApiKeys();
});

test('create key reveals raw owk_live_* once, copies to clipboard, then list shows prefix only', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/settings/api-keys');
  // 10s, not the default 5s: the heading waits on AuthContext hydration, and
  // the IndexedDB→onAuthStateChanged→user-doc chain can outrun 5s cold.
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await expect(page.getByText('no api keys yet')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^create your first key$/i }),
  ).toBeVisible();

  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog', { name: 'create api key' });
  await expect(dialog).toBeVisible();

  const keyName = `e2e-${Date.now()}`;
  await dialog.getByLabel('name').fill(keyName);
  // Distinct from DEFAULT_TTL_DAYS so the assertion pins this run's input.
  await dialog.getByLabel(/^ttl \(days\)$/i).fill('30');

  // Scope defaults to publisher. Await the response so the reveal card is
  // mounted before we read the raw key.
  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create key$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  // a successful create closes the dialog; the reveal lands in the panel
  await expect(dialog).toBeHidden();

  // The raw key renders exactly once, in a <code> beside the copy button.
  const revealBanner = page.getByText(/key issued — copy it now\. it will not be shown again\./i);
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  const rawKey = (await revealCard.locator('code').innerText()).trim();
  expect(rawKey).toMatch(/^owk_live_[A-Za-z0-9_-]{43}$/);

  // UI gap: the copy button is icon-only with no aria-label, so locate it
  // positionally rather than via the Radix tooltip's description.
  const copyButton = revealCard
    .locator('code')
    .locator('xpath=parent::div')
    .locator('button');
  await copyButton.click();
  await expect(page.getByText('copied to clipboard')).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(rawKey);

  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // The prefix-only display sits behind the row's details disclosure, so
  // expand first. The raw key must NOT be anywhere on the page.
  const expectedPrefix = rawKey.slice(0, 15);
  const keyRow = page.getByText(keyName);
  await expect(keyRow).toBeVisible();
  await page.getByRole('button', { name: `show details for ${keyName}` }).click();
  await expect(page.locator('code', { hasText: expectedPrefix })).toBeVisible();
  await expect(page.getByText(rawKey, { exact: true })).toHaveCount(0);

  // The contract holds across navigations; expansion state resets on reload.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(keyName)).toBeVisible();
  await page.getByRole('button', { name: `show details for ${keyName}` }).click();
  await expect(page.locator('code', { hasText: expectedPrefix })).toBeVisible();
  await expect(page.getByText(rawKey, { exact: true })).toHaveCount(0);
});

test('switching to custom carries the selected preset in, rather than resetting it', async ({
  page,
}) => {
  await page.goto('/settings/api-keys');
  await expect(
    page.getByRole('heading', { name: 'api keys', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog', { name: 'create api key' });
  await expect(dialog).toBeVisible();

  const keyName = `e2e-inherit-${Date.now()}`;
  await dialog.getByLabel('name').fill(keyName);

  // While a preset is selected the scope <Select> is the only combobox; the
  // per-row pickers appear with the custom builder, so pick operator first.
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'operator' }).click();
  // Must commit first: on a cold server, re-opening the select mid-commit
  // silently carries the DEFAULT preset into custom (1 row, not 4).
  await expect(dialog.getByRole('combobox').first()).toHaveText(/operator/);

  // This transition used to discard the preset — rows opened on one hardcoded
  // site scope, dropping 3 of 4 resources and 14 of 16 grants, and every
  // validator accepted the result.
  await dialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'custom' }).click();

  await expect(dialog.getByPlaceholder('id (or * for all)')).toHaveCount(4);

  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create key$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);

  // The wire body must still be operator.
  const sent = JSON.parse(response.request().postData() ?? '{}');
  expect(sent.scopes).toEqual([
    { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
    { resource: 'site', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
    { resource: 'machine', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
    { resource: 'chat', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
  ]);
});

test('create dialog nested over account settings traps focus and closes alone', async ({
  page,
}) => {
  await page.goto('/dashboard');
  await page.getByTestId('user-menu-trigger').click();
  await page.getByRole('menuitem', { name: /account settings/i }).click();
  await page
    .getByRole('navigation', { name: 'settings sections' })
    .filter({ visible: true })
    .getByRole('button', { name: 'api', exact: true })
    .click();
  const sectionHeading = page.getByRole('heading', { name: 'api keys', exact: true });
  await expect(sectionHeading).toBeVisible();

  const create = page.getByRole('dialog', { name: 'create api key' });
  await page.getByRole('button', { name: /^create key$/i }).click();
  await expect(create).toBeVisible();
  await expect(create.getByLabel('name')).toBeFocused();

  // focus cycles inside the inner dialog, never back into account settings
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await create.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();
  await expect(sectionHeading).toBeVisible();

  // the inner overlay covers the viewport, so a corner click lands on it. wait
  // out the open animation first: radix re-arms the nested layer's outside-click
  // listener just after mount, and a click inside that window is ignored.
  await page.getByRole('button', { name: /^create key$/i }).click();
  await expect(create).toBeVisible();
  await create.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  await page.mouse.click(4, 4);
  await expect(create).toBeHidden();
  await expect(sectionHeading).toBeVisible();
});
