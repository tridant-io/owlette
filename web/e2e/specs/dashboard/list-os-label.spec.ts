/**
 * Machine list — the OS line sits under the hostname's first letter and fits
 * its 130px column by abbreviating, never by hiding behind an ellipsis.
 *
 * Two machines: a Windows one whose full string ("Windows 11 Pro 23H2") does
 * not fit the column at text-xs and must come back as one of its shorter
 * forms, and an Ubuntu one for the LTS / dotted-version path.
 */

import { test, expect } from '@playwright/test';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';

const SITE_ID = TEST_SITES[0].id;
const WIN_ID = 'e2e-os-label-win';
const UBUNTU_ID = 'e2e-os-label-ubuntu';

async function setOs(machineId: string, osFamily: string, osVersion: string): Promise<void> {
  await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .set({ osFamily, osVersion }, { merge: true });
}

test.beforeAll(async () => {
  await seedMachine(SITE_ID, WIN_ID);
  await seedMachine(SITE_ID, UBUNTU_ID);
  await setOs(WIN_ID, 'windows', 'Windows 11 Pro 23H2');
  await setOs(UBUNTU_ID, 'linux', 'Ubuntu 24.04.5 LTS');
});

test.describe('machine list os label — admin on site-A', () => {
  test.use(roleState('admin'));

  test('the os line starts under the hostname and abbreviates to fit', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('view-toggle-list').click();

    for (const [machineId, forms] of [
      [WIN_ID, ['Windows 11 Pro 23H2', 'Win 11 Pro 23H2', 'Win 11 Pro']],
      [UBUNTU_ID, ['Ubuntu 24.04.5 LTS', 'Ubuntu 24.04.5', 'Ubuntu 24.04', 'Ubuntu 24']],
    ] as const) {
      const row = page.getByRole('row').filter({ hasText: machineId }).first();
      await expect(row).toBeVisible();
      const hostname = row.getByText(machineId, { exact: true });
      const os = row.getByTestId('machine-os-version');
      await expect(os).toBeVisible();

      // the label is written into the dom by a layout effect; wait for a form
      // that fits before measuring.
      await expect
        .poll(async () => os.evaluate((el) => el.scrollWidth <= el.clientWidth))
        .toBe(true);
      const shown = (await os.textContent())?.trim();
      expect(forms).toContain(shown);
      await expect(os).toHaveAttribute('title', forms[0]);

      // the os text starts where the hostname text starts: measure the text
      // itself, since the os span spans the cell.
      const hostnameLeft = (await hostname.boundingBox())!.x;
      const osTextLeft = await os.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      });
      expect(Math.abs(osTextLeft - hostnameLeft)).toBeLessThanOrEqual(1);
    }
  });
});
