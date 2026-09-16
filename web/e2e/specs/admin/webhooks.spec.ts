/**
 * Admin — webhooks page. Reads `sites/{siteId}/webhooks` via onSnapshot (`useWebhooks` in
 * WebhookSettingsDialog.tsx). Seeds a dedicated `site-webhook-tests` site so reruns are
 * deterministic and shared baseline state is untouched.
 *
 * Covers list rendering, create (→ secret dialog + Admin SDK doc-shape check), edit (→ updated
 * URL), and delete (→ soft-deleted doc).
 *
 * Not covered: test-send (hits real HTTP, flaky) and the disable/enable toggle.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-webhook-tests';
const SITE_NAME = 'Z Webhook Test Site';

const SEEDED_WEBHOOK = {
  name: 'seeded webhook',
  url: 'https://example.com/seeded-hook',
  events: ['machine.offline', 'deployment.failed'],
};

async function clearWebhooks() {
  const db = getAdminDb();
  const col = db.collection('sites').doc(SITE_ID).collection('webhooks');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await clearWebhooks();
});

async function seedWebhook(name = SEEDED_WEBHOOK.name, url = SEEDED_WEBHOOK.url) {
  const db = getAdminDb();
  const ref = db.collection('sites').doc(SITE_ID).collection('webhooks').doc();
  await ref.set({
    description: name,
    url,
    events: SEEDED_WEBHOOK.events,
    paused: false,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: 'super-uid',
    lastDeliveryAt: null,
    lastDeliveryStatus: null,
    failureCount: 0,
    deletedAt: null,
  });
  return ref.id;
}

async function gotoWebhooksForSeededSite(page: Page) {
  await page.goto('/admin/webhooks');
  // Superadmin always gets the site selector; pick the seeded site by name. 10s because
  // RequireAdminAccess gates on AuthContext hydrating against the auth emulator, which races the
  // default 5s timeout on cold-emulator runs.
  await expect(
    page.getByRole('heading', { name: 'webhooks', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const siteSelect = page.getByRole('combobox');
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(page.getByRole('combobox')).toContainText(SITE_NAME);
}

test('lists seeded webhooks with name, URL, and status badge', async ({ page }) => {
  await seedWebhook();
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_WEBHOOK.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText(SEEDED_WEBHOOK.url);
  await expect(row.getByText('never triggered', { exact: true })).toBeVisible();
});

test('creating a webhook writes Firestore doc and shows the signing secret', async ({ page }) => {
  await gotoWebhooksForSeededSite(page);

  await page.getByRole('button', { name: /add webhook/i }).click();

  const addDialog = page.getByRole('dialog', { name: /^add webhook$/i });
  await expect(addDialog).toBeVisible();

  const newName = 'E2E Created Webhook';
  const newUrl = 'https://example.com/new-e2e-hook';

  await addDialog.getByLabel('name').fill(newName);
  await addDialog.getByLabel(/URL/).fill(newUrl);
  // machine.offline + deployment.failed are checked by default — leave as-is.

  await addDialog.getByRole('button', { name: /^create webhook$/i }).click();

  await expect(page.getByText(/webhook created/i).first()).toBeVisible();
  const secretDialog = page.getByRole('dialog', { name: /^webhook created$/i });
  await expect(secretDialog).toBeVisible();
  // whsec_ + 64-char hex.
  await expect(secretDialog.locator('code')).toHaveText(/^whsec_[0-9a-f]{64}$/);
  await secretDialog.getByRole('button', { name: /^done$/i }).click();

  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').get();
  const matching = snap.docs.find((d) => d.data().description === newName);
  expect(matching).toBeDefined();
  const data = matching!.data();
  expect(data.url).toBe(newUrl);
  expect(data.paused).toBe(false);
  expect(data.events).toEqual(expect.arrayContaining(['machine.offline', 'deployment.failed']));
  // The secret is in the server-only sibling, never on this document.
  expect(data.signingSecret).toBeUndefined();
  const secretSnap = await db
    .collection('sites').doc(SITE_ID)
    .collection('webhook_secrets').doc(matching!.id).get();
  expect(secretSnap.data()?.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
});

test('editing a webhook updates the Firestore URL', async ({ page }) => {
  const webhookId = await seedWebhook();
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: SEEDED_WEBHOOK.name });
  // No accessible name on the pencil button; target the lucide SVG class. Same for trash below.
  await row.locator('button:has(svg.lucide-pencil)').click();

  const editDialog = page.getByRole('dialog', { name: /^edit webhook$/i });
  await expect(editDialog).toBeVisible();

  const newUrl = 'https://example.com/edited-e2e-hook';
  const urlInput = editDialog.getByLabel(/URL/);
  await urlInput.fill(newUrl);

  await editDialog.getByRole('button', { name: /save changes/i }).click();
  await expect(page.getByText(/webhook updated/i)).toBeVisible();

  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').doc(webhookId).get();
  expect(snap.data()!.url).toBe(newUrl);
});

test('deleting a webhook removes the Firestore doc', async ({ page }) => {
  const webhookId = await seedWebhook('to-be-deleted', 'https://example.com/byebye');
  await gotoWebhooksForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: 'to-be-deleted' });
  await expect(row).toBeVisible();

  await row.locator('button:has(svg.lucide-trash-2)').click();
  await row.getByRole('button', { name: /^confirm$/i }).click();

  await expect(page.getByText(/webhook deleted/i)).toBeVisible();

  const db = getAdminDb();
  const snap = await db.collection('sites').doc(SITE_ID).collection('webhooks').doc(webhookId).get();
  expect(snap.exists).toBe(true);
  expect(snap.data()!.deletedAt).toBeDefined();
  expect(snap.data()!.paused).toBe(true);
});
