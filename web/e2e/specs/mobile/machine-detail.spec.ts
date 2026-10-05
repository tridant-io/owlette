/**
 * Mobile — machine detail (expanded card). Viewport/isMobile/hasTouch come from
 * the `mobile-chromium` project, which owns every spec under specs/mobile/**.
 *
 * responsive-acceptance.spec.ts proves the dashboard RENDERS at 390px; this
 * proves the card is OPERABLE there, with an overflow assertion after each step
 * so a control that "works" by pushing the document sideways still fails.
 *
 * The three expand/collapse toggles are USER PREFERENCES, not component state —
 * toggling one writes `users/admin-uid.preferences` and every other spec that
 * renders a machine card inherits it. Hence `resetExpandPrefs` in both
 * `beforeEach` and `afterAll`; see commit cb94099 for that failure mode.
 */

import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-detail-machine';
const PROCESS_ID = 'e2e-mobile-detail-proc';
const PROCESS_NAME = 'TouchDesigner.exe';
const CPU_PERCENT = 42;
const MEMORY_PERCENT = 61;

/**
 * Minimum touch target for controls tagged `pointer-coarse:h-10 w-10`.
 * `hasTouch` makes `pointer: coarse` match, so the variant is live here and
 * dead in the `chromium` project.
 */
const MIN_TOUCH_TARGET_PX = 40;

/**
 * Extend the seeded machine with the v2 metric shape the stats section renders.
 * `joinMachineDevices` derives a metric-only hardware profile when no
 * `hardware/profile` doc exists, so `metrics.cpus` + `metrics.memory` suffice.
 */
async function seedDetailMachine(): Promise<void> {
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
          cpus: { CPU0: { percent: CPU_PERCENT, temperature: 54 } },
          memory: { percent: MEMORY_PERCENT, usedGb: 19.5 },
          primary: { cpu: 'CPU0' },
          processes: {
            [PROCESS_ID]: {
              name: PROCESS_NAME,
              status: 'RUNNING',
              pid: 4242,
              cpu_percent: 3.5,
              memory_mb: 512,
            },
          },
        },
      },
      { merge: true },
    );
}

/** Open the dashboard and scope to this spec's machine card. */
async function cardFor(page: Page): Promise<Locator> {
  await page.goto('/dashboard');
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  return card;
}

test.describe('mobile machine detail — admin on site-A', () => {
  test.use(roleState('admin'));

  /** Pin the three expand flags to the app defaults (all `?? true`) so the
   * collapse/expand test can't leave a later test on a collapsed card. */
  async function resetExpandPrefs(): Promise<void> {
    await getAdminDb()
      .collection('users')
      .doc(TEST_USERS.admin.uid)
      .set(
        {
          preferences: {
            statsExpanded: true,
            processesExpanded: true,
            displaysExpanded: true,
          },
        },
        { merge: true },
      );
  }

  test.beforeAll(async () => {
    await seedDetailMachine();
  });

  test.beforeEach(async () => {
    await resetExpandPrefs();
  });

  test.afterAll(async () => {
    await resetExpandPrefs();
    // Drop the machine so the next spec sees an unchanged card count.
    await getAdminDb()
      .collection('sites')
      .doc(SITE_ID)
      .collection('machines')
      .doc(MACHINE_ID)
      .delete();
  });

  test('collapsing and re-expanding the card sections keeps the page inside the viewport', async ({ page }) => {
    const card = await cardFor(page);

    // All three sections default expanded, so this is the widest the card gets.
    await expect(card.getByText(`${CPU_PERCENT}%`, { exact: true })).toBeVisible();
    await expect(card.getByText(`${MEMORY_PERCENT}%`, { exact: true })).toBeVisible();
    await expect(card.getByText(PROCESS_NAME, { exact: true })).toBeVisible();
    await expect(card.getByText('running', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 2', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'collapse all', exact: true }).click();

    // Collapsed: each section falls back to its one-line summary trigger.
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeHidden();
    await expect(card.getByRole('button').filter({ hasText: /2 displays/i })).toBeVisible();
    await expect(card.getByRole('button').filter({ hasText: /1 process/i })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Located by TEXT, not accessible name — the header's icon-only display
    // shortcut carries `aria-label="view displays"` and would also match.
    await card.getByRole('button').filter({ hasText: /2 displays/i }).click();
    await expect(card.getByText('Test Monitor 1', { exact: true })).toBeVisible();
    await expect(card.getByText('Test Monitor 2', { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // Back to fully expanded so the card ends as it started.
    await page.locator('button:has(svg.lucide-chevrons-up-down)').click();
    await expect(card.getByText(PROCESS_NAME, { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('the context menu has a touch-sized trigger and opens its admin actions', async ({ page }) => {
    const card = await cardFor(page);

    // `pointer-coarse:h-10/w-10` only resolves when the primary pointer is
    // coarse. Assert the grown size, not the class.
    // polled: mid page-rise the translate leaves the box a hair under 40px
    const trigger = card.getByTestId('machine-context-menu-trigger');
    await expect.poll(async () => (await trigger.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await expect.poll(async () => (await trigger.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
    await expect(menu.getByTestId('machine-context-menu-remove')).toBeVisible();

    await assertNoHorizontalOverflow(page);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('tapping a metric row opens the metrics detail panel', async ({ page }) => {
    const card = await cardFor(page);

    // The row carries the handler and the percentage is a child, so the tap
    // bubbles. No metrics_history seeded → deterministic empty-range copy.
    await card.getByText(`${CPU_PERCENT}%`, { exact: true }).click();
    await expect(
      page.getByText(/no data available for this time range/i),
    ).toBeVisible({ timeout: 15_000 });

    await assertNoHorizontalOverflow(page);
  });

  test('tapping the display icon opens the display layout panel', async ({ page }) => {
    const card = await cardFor(page);

    await card.getByTestId('open-display-panel').click();
    const panel = page.getByTestId('display-layout-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('display-store-button')).toBeVisible();

    await assertNoHorizontalOverflow(page);
  });
});
