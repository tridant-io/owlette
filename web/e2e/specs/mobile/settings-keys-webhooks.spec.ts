/**
 * Mobile — settings: api keys + webhooks. Viewport/isMobile/hasTouch come from
 * the `mobile-chromium` project in playwright.config.ts.
 *
 * Where responsive-acceptance measures the routes with a seeded row, this
 * drives the two CREATE dialogs at 390px and asserts the one-time reveal
 * lands inside the viewport rather than off the right edge.
 *
 * Both fixtures tear down in `afterEach`, leaving the key list and webhook
 * collection empty as the desktop specs do.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const ADMIN_UID = TEST_USERS.admin.uid;
const WEBHOOK_URL = 'https://example.com/mobile/hook';
const SUBSCRIBED_EVENTS = ['version.published', 'deployment.completed'] as const;

async function clearApiKeys(): Promise<void> {
  const db = getAdminDb();
  const [userKeys, lookups] = await Promise.all([
    db.collection('users').doc(ADMIN_UID).collection('api_keys').get(),
    db.collection('api_keys').where('userId', '==', ADMIN_UID).get(),
  ]);
  await Promise.all([
    ...userKeys.docs.map((d) => d.ref.delete()),
    ...lookups.docs.map((d) => d.ref.delete()),
  ]);
}

async function clearWebhooks(): Promise<void> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await Promise.all([clearApiKeys(), clearWebhooks()]);
});

test.afterEach(async () => {
  await Promise.all([clearApiKeys(), clearWebhooks()]);
});

test('api keys: create dialog and one-time reveal are operable at 390px', async ({ page }) => {
  await page.goto('/settings/api-keys');
  // The heading waits on AuthContext hydration; a full-screen loader precedes it.
  await expect(page.getByRole('heading', { name: 'api keys', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('no api keys yet')).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: /^create key$/i }).click();
  const dialog = page.getByRole('dialog', { name: 'create api key' });
  await expect(dialog).toBeVisible();

  const keyName = `e2e-mobile-${Date.now()}`;
  await dialog.getByLabel('name').fill(keyName);
  await dialog.getByLabel(/^ttl \(days\)$/i).fill('30');
  await assertNoHorizontalOverflow(page);

  const responsePromise = page.waitForResponse(
    (res) => res.url().endsWith('/api/keys') && res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create key$/i }).click();
  expect((await responsePromise).status()).toBe(200);
  await expect(dialog).toBeHidden();

  // The raw key renders exactly once, inside a <code>.
  const revealBanner = page.getByText(
    /key issued — copy it now\. it will not be shown again\./i,
  );
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  const rawKey = (await revealCard.locator('code').innerText()).trim();
  expect(rawKey).toMatch(/^owk_live_[A-Za-z0-9_-]{43}$/);
  await assertNoHorizontalOverflow(page);

  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // The prefix-only display sits behind the row's details disclosure.
  await expect(page.getByText(keyName)).toBeVisible();
  await page.getByRole('button', { name: `show details for ${keyName}` }).click();
  await expect(page.locator('code', { hasText: rawKey.slice(0, 15) })).toBeVisible();
  await expect(page.getByText(rawKey, { exact: true })).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test('webhooks: create dialog and one-time reveal are operable at 390px', async ({ page }) => {
  await page.goto('/settings/webhooks');
  await expect(page.getByRole('heading', { name: 'webhooks', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText('no webhooks yet')).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await page.getByRole('button', { name: /^create webhook$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^create webhook$/i })).toBeVisible();

  await dialog.getByLabel('endpoint url').fill(WEBHOOK_URL);
  for (const evt of SUBSCRIBED_EVENTS) {
    // Radix Checkbox is a <button>, not a native input — click the wrapping label.
    await dialog.locator('label', { hasText: evt }).click();
  }
  await assertNoHorizontalOverflow(page);

  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/webhooks') &&
      res.url().includes(`siteId=${SITE_ID}`) &&
      res.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await dialog.getByRole('button', { name: /^create webhook$/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { id: string; signingSecret: string };
  expect(body.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);

  const revealBanner = page.getByText(
    /signing secret issued — copy it now\. it will not be shown again\./i,
  );
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  await expect(revealCard.locator('code')).toHaveText(body.signingSecret);
  await assertNoHorizontalOverflow(page);

  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // The list row renders the long url + the two subscribed event badges.
  const card = page
    .locator(`code:has-text("${WEBHOOK_URL}")`)
    .locator('xpath=ancestor::*[@data-slot="card"][1]');
  await expect(card).toBeVisible();
  await expect(card.getByText('active', { exact: true })).toBeVisible();
  for (const evt of SUBSCRIBED_EVENTS) {
    await expect(card.getByText(evt, { exact: true })).toBeVisible();
  }
  await assertNoHorizontalOverflow(page);
});
