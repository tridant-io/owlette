/**
 * Dispatch — clear assigned display layout. Inverse of D3.1 (store).
 *
 * Pre-seeds `config/{siteId}/machines/{id}.displays.assigned` with a stub
 * monitors array so the clear button renders (gated on `hasAssignedLayout`),
 * then drives list view → view displays → assigned tab → clear → confirm.
 * `useDisplayActions.clearLayout` deleteField()s `displays.assigned` and
 * turns auto-restore off; the other `displays` keys must survive.
 *
 * No agent stub — clearLayout is a pure client-SDK Firestore write.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { roleState } from '../../helpers/roles';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine } from '../../helpers/seed';

test.use(roleState('admin'));

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-clear-layout-target';

async function seedAssignedLayout() {
  const db = getAdminDb();
  // Must mirror the monitor shape seedMachine writes to hardware/display
  // (position {x,y}, resolution {width,height}, primary). The wrong shape —
  // positionX/widthPx/isPrimary — makes the panel throw into the global
  // "something went wrong" boundary.
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).set(
    {
      displays: {
        assigned: {
          monitors: [
            {
              id: `MONITOR\\TEST0`,
              edidHash: `hash-${MACHINE_ID}-0`,
              manufacturerId: 'TST',
              productCode: '0000',
              serialNumber: 'SN0',
              friendlyName: 'Test Monitor 1',
              position: { x: 0, y: 0 },
              resolution: { width: 1920, height: 1080 },
              refreshHz: 60,
              rotation: 0,
              scalePct: 100,
              primary: true,
              connectionType: 'dp',
              adapterLuid: '0:0',
              targetId: 0,
            },
          ],
          capturedAt: Timestamp.now(),
          capturedBy: 'admin@e2e.test',
        },
      },
    },
    { merge: true },
  );
}

test.beforeEach(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedAssignedLayout();
});

test('admin clears the assigned display layout — deleteField removes it + assigned tab returns to empty state', async ({ page }) => {
  await page.goto('/dashboard');

  await page.getByTestId('view-toggle-list').click();
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  const panel = page.getByTestId('display-layout-panel');
  await expect(panel).toBeVisible();

  // Clear is only visible on the assigned tab — switch first.
  await panel.getByRole('button', { name: /^stored\b/i }).click();

  await panel.getByTestId('display-clear-button').click();

  const confirmDialog = page.getByRole('dialog', { name: /^clear assigned layout\?$/i });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: /^clear$/i }).click();

  // Wait for the success toast as evidence clearLayout's setDoc resolved.
  await expect(page.getByText('assigned layout cleared', { exact: true })).toBeVisible({ timeout: 10_000 });

  // Admin SDK read-through — displays.assigned is gone after deleteField.
  const db = getAdminDb();
  const configSnap = await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).get();
  const data = configSnap.data();
  // displays may still exist (sibling fields survive), but assigned must be gone.
  expect(data?.displays?.assigned).toBeUndefined();

  // Same testid B3.1 covers from the other direction (admin sees it; member
  // doesn't).
  await expect(panel.getByTestId('display-store-current-button')).toBeVisible();
  // Clear button itself disappears once hasAssignedLayout is false.
  await expect(panel.getByTestId('display-clear-button')).toHaveCount(0);
});
