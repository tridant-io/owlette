/**
 * a site's screenshots are for its members. a member of site-A opens a machine's
 * screenshot; super-uid, a superadmin with no member row on site-A, gets no
 * screenshot in the same machine's menu, and the image route refuses its session.
 * the record's url is a data url, as the dialog specs seed it, because the rig
 * cannot sign a storage read (screenshot-image.spec.ts).
 */

import { test, expect, type Page } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_SITES } from '../../helpers/seed';
import { openScreenshotDialog, removeScreenshotMachine, seedScreenshotMachine } from '../../helpers/screenshotDialog';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-screenshot-members-machine';
const SHOT_ID = 'e2e-members-shot-1';
const IMAGE_ROUTE = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/screenshots/image?path=${encodeURIComponent(
  `screenshots/${SITE_ID}/${MACHINE_ID}/1700000000000-aabbccdd.jpg`,
)}`;

test.beforeAll(() => seedScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));
test.afterAll(() => removeScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));

/** the machine's menu, open, on site-A's dashboard */
async function openMachineMenu(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const siteSwitcher = page.getByTestId('site-switcher-trigger');
  await expect(siteSwitcher).toBeVisible();
  if (!((await siteSwitcher.textContent()) ?? '').includes(TEST_SITES[0].name)) {
    await siteSwitcher.click();
    await page.getByRole('menuitem', { name: TEST_SITES[0].name }).click();
    await expect(siteSwitcher).toContainText(TEST_SITES[0].name);
  }
  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  await card.getByTestId('machine-context-menu-trigger').click();
  await expect(page.getByRole('menu')).toBeVisible();
}

test.describe('a member of the site', () => {
  test.use(roleState('member'));

  test("opens the machine's screenshot", async ({ page }) => {
    const dialog = await openScreenshotDialog(page, MACHINE_ID);

    await expect(dialog.getByRole('img', { name: `screenshot of ${MACHINE_ID}` })).toBeVisible();
  });
});

test.describe('a superadmin who is not a member of the site', () => {
  test.use(roleState('superadmin'));

  test('gets no screenshot in the machine menu, and the image route refuses them', async ({ page }) => {
    await openMachineMenu(page);
    // the menu is the machine's: hoot is there, the screenshot is not
    await expect(page.getByTestId('machine-context-menu-hoot')).toBeVisible();
    await expect(page.getByTestId('machine-context-menu-screenshot')).toHaveCount(0);

    const res = await page.request.get(IMAGE_ROUTE, { maxRedirects: 0 });
    expect(res.status()).toBe(403);
    expect((await res.json()).detail).toBe("screenshots are visible only to the site's members");
  });
});
