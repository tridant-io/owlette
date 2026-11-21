/**
 * Mobile — the screenshot dialog gives the screenshot the width at 390px.
 *
 * The history sidebar was a fixed 208px column beside the image and open by
 * default, which left the screenshot ~150px wide inside a ~358px dialog. Below
 * md the history now stacks under the image. The fullscreen view is a real
 * modal: Escape closes it and leaves the dialog open.
 */

import { test, expect } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { TEST_SITES, seedMachine } from '../../helpers/seed';
import { stubScreenshotCapture } from '../../helpers/stubAgent';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-screenshot-machine';
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
const MIN_IMAGE_WIDTH_PX = 300;

function machineRef() {
  return getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID);
}

test.describe('mobile screenshot dialog — admin on site-A', () => {
  test.use(roleState('admin'));

  test.beforeAll(async () => {
    await seedMachine(SITE_ID, MACHINE_ID);
    // a stored capture, so opening the dialog shows it instead of sending a new capture
    await stubScreenshotCapture(SITE_ID, MACHINE_ID, PNG_1X1);
    await machineRef().collection('screenshots').doc('e2e-mobile-shot-1').set({
      url: PNG_1X1,
      timestamp: Timestamp.now(),
      sizeKB: 128,
    });
  });

  test.afterAll(async () => {
    await machineRef().collection('screenshots').doc('e2e-mobile-shot-1').delete();
    await machineRef().delete();
  });

  test('the screenshot fills the dialog width and fullscreen closes on its own', async ({ page }) => {
    await page.goto('/dashboard');
    const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
    await expect(card).toBeVisible();

    await card.getByTestId('machine-context-menu-trigger').click();
    await page.getByRole('menuitem', { name: 'screenshot' }).click();

    const dialog = page.getByRole('dialog', { name: new RegExp(`screenshot — ${MACHINE_ID}`) });
    await expect(dialog).toBeVisible();

    const image = dialog.getByRole('img', { name: `screenshot of ${MACHINE_ID}` });
    await expect(image).toBeVisible();
    const box = await image.boundingBox();
    expect(box, 'screenshot has no bounding box').not.toBeNull();
    expect(box!.width).toBeGreaterThan(MIN_IMAGE_WIDTH_PX);

    // touch has no hover, so the per-item delete is shown outright rather than on hover
    await expect(dialog.getByRole('button', { name: 'delete screenshot' })).toHaveCSS('opacity', '1');

    await dialog.getByRole('button', { name: 'fullscreen' }).click();
    const lightbox = page.getByRole('dialog', { name: `screenshot of ${MACHINE_ID}` });
    await expect(lightbox).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'close image' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'close' }).click();
    await expect(dialog).toBeHidden();
  });
});
