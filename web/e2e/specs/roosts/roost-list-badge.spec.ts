/**
 * Roosts — a versioned list row renders its v{N} badge, description preview
 * (40 chars + ellipsis when longer), a timestamp, and the row-actions trigger.
 * No data plane.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedRoostWithVersionHistory } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-roost-list-badge';
const ROOST_ID = 'rst_test_badge_001';

// Keep in sync with DESCRIPTION_PREVIEW_CAP in `web/app/roosts/page.tsx`.
const DESCRIPTION_PREVIEW_CAP = 40;

async function cleanupRoost() {
  const db = getAdminDb();
  const versions = await db
    .collection('sites').doc(SITE_ID)
    .collection('roosts').doc(ROOST_ID)
    .collection('versions').get();
  await Promise.all(versions.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('roosts').doc(ROOST_ID).delete();
}

test.beforeEach(async () => {
  await cleanupRoost();
  await seedMachine(SITE_ID, MACHINE_ID);
});

test.afterEach(async () => {
  await cleanupRoost();
});

test('row renders v3 badge, short description preview, timestamp, and three-dot trigger', async ({ page }) => {
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: [null, 'Initial publish', 'Bumped Q2 ads'],
  });

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  // No `listitem` role: the wrapper is a div and the clickable region a button
  // stamped `data-roost-row`. Scope to it so assertions match one row.
  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');
  await expect(row.getByText(ROOST_ID)).toBeVisible();

  await expect(row.getByLabel('current version v3')).toHaveText('v3');

  // Under the 40-char cap — rendered as-is.
  await expect(row.getByText('Bumped Q2 ads', { exact: true })).toBeVisible();

  // `formatSiteScopedTimestamp` is absolute here, not relative, and the row
  // asks for the abbreviated month so the column can't overflow its box. Match
  // month + year + HH:MM so the assertion isn't pinned to wall-clock seconds.
  await expect(
    row.getByText(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d+, \d{4}(?:,?\s+| at )\d{1,2}:\d{2}/i)
  ).toBeVisible();

  await expect(row.getByRole('button', { name: 'row actions' })).toBeVisible();
});

test('long description is truncated to 40 chars with an ellipsis', async ({ page }) => {
  // Over the cap — first 40 chars + U+2026.
  const longDescription = 'a'.repeat(100);
  await seedRoostWithVersionHistory(SITE_ID, ROOST_ID, {
    versionCount: 3,
    descriptions: [null, 'Initial publish', longDescription],
  });

  await page.goto('/roosts');
  await expect(page.getByRole('heading', { name: 'roosts', exact: true })).toBeVisible();

  const rowButton = page.locator(`button[data-roost-row="${ROOST_ID}"]`);
  await expect(rowButton).toBeVisible();
  const row = rowButton.locator('..');

  const expectedPreview = `${longDescription.slice(0, DESCRIPTION_PREVIEW_CAP)}…`;
  await expect(row.getByText(expectedPreview, { exact: true })).toBeVisible();
  await expect(row.getByText(longDescription, { exact: true })).toHaveCount(0);
});
