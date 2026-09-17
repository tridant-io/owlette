/**
 * Admin — schedule presets (`config/{siteId}/schedule_presets/{presetId}`).
 * `useSchedulePresets` merges the Firestore listener with `BUILT_IN_PRESETS`,
 * so the four built-ins render even against an empty collection.
 *
 * Covers list rendering (built-in badge, no trash button), create, and delete,
 * each verified through the Admin SDK. The time-block editor is not exercised:
 * the form defaults to DEFAULT_SCHEDULE, so name-and-save yields a valid doc.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedSite } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SITE_ID = 'site-schedule-tests';
const SITE_NAME = 'Z Schedule Test Site';

async function clearSchedulePresets() {
  const db = getAdminDb();
  const col = db.collection('config').doc(SITE_ID).collection('schedule_presets');
  const snap = await col.get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seedCustomPreset(name: string) {
  const db = getAdminDb();
  const presetId = `sched-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
  await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .doc(presetId)
    .set({
      name,
      description: 'seeded for e2e',
      blocks: [{ days: ['mon', 'tue', 'wed'], ranges: [{ start: '08:00', stop: '18:00' }] }],
      isBuiltIn: false,
      order: 99,
      createdBy: 'super-uid',
      createdAt: Timestamp.now(),
    });
  return presetId;
}

test.beforeEach(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await clearSchedulePresets();
});

async function gotoSchedulesForSeededSite(page: Page) {
  await page.goto('/admin/schedules');
  // 10s: RequireAdminAccess shows a "verifying permissions..." gate while
  // AuthContext hydrates, which races the default 5s on cold-emulator runs.
  await expect(
    page.getByRole('heading', { name: 'schedules', exact: true }),
  ).toBeVisible({ timeout: 10_000 });
  const siteSelect = page.getByRole('combobox');
  await siteSelect.click();
  await page.getByRole('option', { name: SITE_NAME, exact: true }).click();
  await expect(page.getByRole('combobox')).toContainText(SITE_NAME);
}

test('lists all four built-in presets with the built-in badge and no trash', async ({ page }) => {
  await gotoSchedulesForSeededSite(page);

  // Built-ins from web/lib/scheduleDefaults.ts.
  const builtIns = ['business hours', 'extended hours', 'weekday 24h', '24/7'];

  for (const name of builtIns) {
    const row = page.locator('div.rounded-lg.border').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByText('built-in', { exact: true })).toBeVisible();
    // Built-ins have a pencil (to edit/override) but no trash.
    await expect(row.locator('button:has(svg.lucide-pencil)')).toHaveCount(1);
    await expect(row.locator('button:has(svg.lucide-trash-2)')).toHaveCount(0);
  }
});

test('creating a preset writes a Firestore doc with valid blocks', async ({ page }) => {
  await gotoSchedulesForSeededSite(page);

  const presetName = `E2E Custom Preset ${Date.now()}`;
  await page.getByRole('button', { name: /create preset/i }).click();

  // Dialog title is capitalized, unlike the rest of the UI copy.
  const dialog = page.getByRole('dialog', { name: /create schedule preset/i });
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Name').fill(presetName);
  // DEFAULT_SCHEDULE is pre-populated, so submitting straight away is valid.
  await dialog.getByRole('button', { name: /^create preset$/i }).click();

  await expect(page.getByText(new RegExp(`"${presetName}" created`, 'i'))).toBeVisible();

  const row = page.locator('div.rounded-lg.border').filter({ hasText: presetName });
  await expect(row).toBeVisible();
  await expect(row.getByText('built-in', { exact: true })).toHaveCount(0);

  // Admin SDK read-through.
  const db = getAdminDb();
  const snap = await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .get();
  const matching = snap.docs.find((d) => d.data().name === presetName);
  expect(matching).toBeDefined();
  const data = matching!.data();
  expect(data.isBuiltIn).toBe(false);
  expect(Array.isArray(data.blocks)).toBe(true);
  expect(data.blocks.length).toBeGreaterThan(0);
  // Mirrors SchedulePresetDialog's handleSave filter: every block needs at
  // least one day and one range.
  for (const block of data.blocks) {
    expect(block.days.length).toBeGreaterThan(0);
    expect(block.ranges.length).toBeGreaterThan(0);
  }
});

test('deleting a custom preset removes the Firestore doc', async ({ page }) => {
  const presetName = 'Custom to delete';
  const presetId = await seedCustomPreset(presetName);
  await gotoSchedulesForSeededSite(page);

  const row = page.locator('div.rounded-lg.border').filter({ hasText: presetName });
  await expect(row).toBeVisible();
  await row.locator('button:has(svg.lucide-trash-2)').click();

  const confirmDialog = page.getByRole('dialog', { name: /^delete schedule preset$/i });
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText(presetName);

  await confirmDialog.getByRole('button', { name: /^delete$/i }).click();

  await expect(page.getByText(new RegExp(`Preset "${presetName}" deleted`, 'i'))).toBeVisible();

  const db = getAdminDb();
  const snap = await db
    .collection('config')
    .doc(SITE_ID)
    .collection('schedule_presets')
    .doc(presetId)
    .get();
  expect(snap.exists).toBe(false);
});
