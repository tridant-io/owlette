/**
 * Settings — webhooks list: empty state, create dialog, the one-time reveal of
 * the raw `whsec_*` secret, clipboard copy, dismiss, list refresh, and the
 * contract that the secret never resurfaces in a row or after reload.
 *
 * URL is `example.com`, not `ci.example.com`: the create endpoint's
 * `validateWebhookUrl` does a real `dns.lookup()` and the subdomain NXDOMAINs
 * on most resolvers. example.com is RFC 2606 reserved with real A/AAAA records.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { TEST_SITES } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = TEST_SITES[0].id;
const WEBHOOK_URL = 'https://example.com/ci/hook';
const SUBSCRIBED_EVENTS = [
  'version.published',
  'deployment.completed',
  'machine.offline',
] as const;

async function clearWebhooks() {
  const db = getAdminDb();
  const snap = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await clearWebhooks();
});

test.afterEach(async () => {
  await clearWebhooks();
});

test('create webhook reveals whsec_* once, copies to clipboard, then list shows row without secret', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/settings/webhooks');
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });

  // No webhooks seeded for this site.
  await expect(page.getByText('no webhooks yet')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^create your first webhook$/i }),
  ).toBeVisible();

  await page.getByRole('button', { name: /^create webhook$/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /^create webhook$/i })).toBeVisible();

  await dialog.getByLabel('endpoint url').fill(WEBHOOK_URL);
  const description = `e2e ci notifier ${Date.now()}`;
  await dialog.getByLabel(/^description/i).fill(description);

  for (const evt of SUBSCRIBED_EVENTS) {
    // Radix Checkbox is a button, not a native input, so getByRole('checkbox',
    // {name}) is unreliable — click the wrapping label instead.
    await dialog.locator('label', { hasText: evt }).click();
  }

  // Wait for the response so the reveal card is mounted before reading it.
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
  const responseBody = (await response.json()) as { id: string; signingSecret: string };
  expect(responseBody.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
  const webhookId = responseBody.id;

  // The raw secret renders exactly once, in a <code> beside the copy button.
  const revealBanner = page.getByText(
    /signing secret issued — copy it now\. it will not be shown again\./i,
  );
  await expect(revealBanner).toBeVisible();
  const revealCard = revealBanner.locator('xpath=ancestor::*[@data-slot="card"][1]');
  const rawSecret = (await revealCard.locator('code').innerText()).trim();
  expect(rawSecret).toBe(responseBody.signingSecret);

  // Two icon-only buttons on the card; match copy by excluding dismiss.
  const copyButton = revealCard.locator('button:not([aria-label="dismiss"])');
  await copyButton.click();
  await expect(page.getByText('copied to clipboard')).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toBe(rawSecret);

  await revealCard.getByRole('button', { name: 'dismiss' }).click();
  await expect(revealBanner).toBeHidden();

  // WebhookCard is a shadcn Card (`data-slot="card"`); pick the one with our url.
  const row = page
    .locator('[data-slot="card"]')
    .filter({ has: page.locator('code', { hasText: WEBHOOK_URL }) });
  await expect(row).toBeVisible();
  await expect(row.getByText('active', { exact: true })).toBeVisible();
  await expect(row.getByText(description)).toBeVisible();
  for (const evt of SUBSCRIBED_EVENTS) {
    await expect(row.getByText(evt, { exact: true })).toBeVisible();
  }

  // One-time reveal: the secret must be nowhere on the page once dismissed.
  await expect(page.getByText(rawSecret, { exact: true })).toHaveCount(0);

  // Stored plaintext on purpose (see route.ts); no other endpoint surfaces it.
  const snap = await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('webhooks')
    .doc(webhookId)
    .get();
  expect(snap.exists).toBe(true);
  const data = snap.data()!;
  expect(data.url).toBe(WEBHOOK_URL);
  expect(data.events).toEqual(expect.arrayContaining([...SUBSCRIBED_EVENTS]));
  expect(data.paused).toBe(false);
  // The secret is NOT on the client-readable webhook document — that was the leak.
  expect(data.signingSecret).toBeUndefined();
  expect(data.secret).toBeUndefined();
  const secretSnap = await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('webhook_secrets').doc(webhookId).get();
  expect(secretSnap.data()?.signingSecret).toBe(rawSecret);

  // The contract holds across navigations.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('code', { hasText: WEBHOOK_URL })).toBeVisible();
  await expect(page.getByText(rawSecret, { exact: true })).toHaveCount(0);
});

test.describe('as a member', () => {
  test.use(roleState('member'));

  test('the page says who manages webhooks, and asks the api for none', async ({ page }) => {
    const listCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/webhooks')) listCalls.push(req.url());
    });

    await page.goto('/settings/webhooks');
    await expect(page.getByText("this site's webhooks are managed by its admins")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: /create webhook/i })).toHaveCount(0);
    expect(listCalls).toEqual([]);
  });
});
