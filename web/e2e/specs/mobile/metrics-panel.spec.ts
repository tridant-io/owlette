/**
 * Mobile — the metrics detail panel is operable at 390px.
 *
 * The panel slides open inside the dashboard's overflow-hidden wrapper, so a
 * control pushed past the right edge is clipped, not scrolled to: the controls
 * row was one non-wrapping line (metric toggles + six time-range buttons, ~340px
 * of range buttons alone), which left "year" and "all" unreachable, and a long
 * machine name pushed the close button out the same way. Neither shows up as
 * document overflow, so each control is measured directly.
 *
 * Picking a range writes `graphTimeRange` and opening the panel writes
 * `activeGraphPanel` to the admin's preferences; both are put back afterwards so
 * no later spec inherits them.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
// long on purpose: at the title's text-xl it is wider than the panel
const MACHINE_ID = 'e2e-mobile-metrics-panel-long-machine-name';
const CPU_PERCENT = 37;

function adminRef() {
  return getAdminDb().collection('users').doc(TEST_USERS.admin.uid);
}

let priorTimeRange: unknown;

async function openPanel(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  // no metrics_history seeded → the empty-range copy, which renders the full controls row
  await card.getByText(`${CPU_PERCENT}%`, { exact: true }).click();
  await expect(page.getByText(/no data available for this time range/i)).toBeVisible({ timeout: 15_000 });
}

test.describe('mobile metrics panel — admin on site-A', () => {
  test.use(roleState('admin'));

  test.beforeAll(async () => {
    priorTimeRange = (await adminRef().get()).get('preferences.graphTimeRange');
    await seedMachine(SITE_ID, MACHINE_ID);
    await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(MACHINE_ID)
      .set(
        {
          metrics: {
            schemaVersion: 2,
            timestamp: Timestamp.now(),
            cpus: { CPU0: { percent: CPU_PERCENT } },
            memory: { percent: 52, usedGb: 16 },
            primary: { cpu: 'CPU0' },
          },
        },
        { merge: true },
      );
  });

  test.afterAll(async () => {
    await adminRef().set(
      {
        preferences: {
          graphTimeRange: priorTimeRange === undefined ? FieldValue.delete() : priorTimeRange,
          activeGraphPanel: null,
        },
      },
      { merge: true },
    );
    await getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
  });

  test('every time range is on screen and selectable, and the close button stays reachable', async ({ page }) => {
    await openPanel(page);

    const ranges = page.getByRole('group', { name: 'time range' });
    for (const label of ['hour', 'day', 'week', 'month', 'year', 'all']) {
      await expectFullyWithinViewport(page, ranges.getByRole('button', { name: label, exact: true }), `"${label}" range`);
    }

    const all = ranges.getByRole('button', { name: 'all', exact: true });
    await all.click();
    await expect(all).toHaveAttribute('aria-pressed', 'true');

    const close = page.getByTestId('metrics-detail-close-button');
    await expect(close).toHaveAccessibleName('close');
    await expectFullyWithinViewport(page, close, 'panel close button');
    await close.click();
    await expect(close).toBeHidden();
  });
});
