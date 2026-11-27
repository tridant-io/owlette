/**
 * Access-control — DisplayLayoutPanel hides store/restore/clear from anyone failing
 * `isSiteAdmin(siteId)`. Automates the "display panel" row of
 * dev/active/permission-model-split/manual-smoke-checklist.md.
 *
 * Seeds `e2e-display-machine` on site-A with two live monitors so the panel mounts with a
 * real profile, then per role opens the dashboard in list view (one-click "view displays"
 * is stabler than card view's expand-then-click) and asserts on the gated buttons.
 *
 * The checklist's "editor toggle" and "auto-restore toggle" rows have no matching control
 * in the component yet; add assertions here when they ship.
 */

import { test, expect, type Page } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { revokeMembership, seedMachine, seedMemberRow, TEST_USERS } from '../../helpers/seed';

const SITE_ID = 'site-A';
const MACHINE_ID = 'e2e-display-machine';

test.beforeAll(async () => {
  await seedMachine(SITE_ID, MACHINE_ID);
  await getAdminDb()
    .collection('config')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .set({ displays: { remoteApplyEnabled: true } }, { merge: true });
});

/** /dashboard → list view → "view displays" on the seeded row → wait for the panel. */
async function openDisplayPanel(page: Page): Promise<void> {
  await page.goto('/dashboard');

  // List view: one click, versus card view's expand-then-click on the collapsible.
  await page.getByTestId('view-toggle-list').click();

  // Target the seeded row explicitly: a full serial run leaves other site-A machines.
  const row = page.getByTestId('machine-row').filter({ hasText: MACHINE_ID });
  await row.getByTestId('open-display-panel').click();

  // The panel slides open on a height animation — wait for the Card before its children.
  await expect(page.getByTestId('display-layout-panel')).toBeVisible();
}

test.describe('display panel — member on site-A', () => {
  test.use(roleState('member'));

  test('opens the panel but sees no store/restore/clear buttons', async ({ page }) => {
    await openDisplayPanel(page);

    // Members get the live topology, none of the write controls.
    const panel = page.getByTestId('display-layout-panel');
    await expect(panel.getByTestId('display-store-button')).toHaveCount(0);
    await expect(panel.getByTestId('display-recall-button')).toHaveCount(0);
    // Clear needs the assigned tab plus a saved layout; a member never sees it either way.
    await expect(panel.getByTestId('display-clear-button')).toHaveCount(0);
  });
});

test.describe('display panel — admin on site-A', () => {
  test.use(roleState('admin'));

  test('sees store + restore buttons on the live tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    // Visibility is the contract here, not enable-state: no assigned layout leaves restore
    // disabled in the seeded state.
    await expect(panel.getByTestId('display-store-button')).toBeVisible();
    await expect(panel.getByTestId('display-recall-button')).toBeVisible();
  });

  test('sees the "store current" CTA on the empty assigned tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    // Assigned tab with no seeded layout renders the empty state and its gated CTA.
    await panel.getByRole('button', { name: 'stored', exact: true }).click();
    await expect(panel.getByTestId('display-store-current-button')).toBeVisible();
  });
});

test.describe('display panel — superadmin', () => {
  test.use(roleState('superadmin'));

  // the menu, panel or page offers a superadmin its changes only on a site they are a member of (adr 0021)
  test.beforeAll(async () => {
    await seedMemberRow(SITE_ID, TEST_USERS.superadmin.uid, 'admin');
  });
  test.afterAll(async () => {
    await revokeMembership(SITE_ID, TEST_USERS.superadmin.uid);
  });

  test('sees store + restore buttons on the live tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    await expect(panel.getByTestId('display-store-button')).toBeVisible();
    await expect(panel.getByTestId('display-recall-button')).toBeVisible();
  });

  test('sees the "store current" CTA on the empty assigned tab', async ({ page }) => {
    await openDisplayPanel(page);

    const panel = page.getByTestId('display-layout-panel');
    await panel.getByRole('button', { name: 'stored', exact: true }).click();
    await expect(panel.getByTestId('display-store-current-button')).toBeVisible();
  });
});
