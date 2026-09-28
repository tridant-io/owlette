/**
 * Machine card — the collapsed metrics row reads as a left-aligned column.
 *
 * The row is the content of a <button>, and a button centres its text. The
 * five metric cells are 1fr grid tracks, so without an explicit alignment
 * each label floated to the middle of its track: "cpu" landed ~30px right of
 * the "N processes" label in the row below it. This pins the two labels to
 * the same left edge.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, TEST_USERS, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-metrics-row-machine';

/** The seed opens both card sections; the collapsed rows are what this spec measures. */
async function setCardSections(expanded: boolean): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(TEST_USERS.admin.uid)
    .set({ preferences: { statsExpanded: expanded, processesExpanded: expanded } }, { merge: true });
}

test.beforeAll(async () => {
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
          cpus: { CPU0: { percent: 40, temperature: 54 } },
          memory: { percent: 50, usedGb: 16 },
          primary: { cpu: 'CPU0' },
          processes: {
            'e2e-metrics-row-proc': {
              name: 'TouchDesigner.exe',
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
  await setCardSections(false);
});

test.afterAll(async () => {
  await setCardSections(true);
});

test.describe('machine card metrics row — admin on site-A', () => {
  // a wide card: at the default 1280px the cell is barely wider than its text,
  // which hides the centring the bug is about.
  test.use({ ...roleState('admin'), viewport: { width: 1920, height: 1080 } });

  test('the cpu label starts where the processes label starts', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    await expect(card).toBeVisible();

    // the cell spans fill their grid tracks, so measure the text itself: the
    // "cpu " text node's own rect, and the process count's span (its text
    // starts the label).
    const cpuCell = card.locator('span', { hasText: /^cpu\s/ }).first();
    await expect(cpuCell).toBeVisible();
    const cpuTextLeft = await cpuCell.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.firstChild as Node);
      return range.getBoundingClientRect().left;
    });

    const processLabel = card.getByText(/^1\s*process$/);
    await expect(processLabel).toBeVisible();
    const processLeft = (await processLabel.boundingBox())!.x;

    expect(Math.abs(cpuTextLeft - processLeft)).toBeLessThanOrEqual(1);
  });
});
