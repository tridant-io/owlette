/**
 * Mobile — the screenshot dialog gives the screenshot the width at 390px.
 *
 * The history sidebar was a fixed 208px column beside the image and open by
 * default, which left the screenshot ~150px wide inside a ~358px dialog. Below
 * md the history now stacks under the image. The fullscreen view is a real
 * modal: Escape closes it and leaves the dialog open.
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_SITES } from '../../helpers/seed';
import { openScreenshotDialog, removeScreenshotMachine, seedScreenshotMachine } from '../../helpers/screenshotDialog';
import { recordSlides } from '../../helpers/slide';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-mobile-screenshot-machine';
const SHOT_ID = 'e2e-mobile-shot-1';
const MIN_IMAGE_WIDTH_PX = 300;

test.describe('mobile screenshot dialog — admin on site-A', () => {
  test.use(roleState('admin'));

  test.beforeAll(() => seedScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));
  test.afterAll(() => removeScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));

  test('the screenshot fills the dialog width and fullscreen closes on its own', async ({ page }) => {
    const dialog = await openScreenshotDialog(page, MACHINE_ID);

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

  // stacked under the screenshot, the history slides down, as the other panels do;
  // from md it slides across (dashboard/screenshot-history.spec.ts)
  test('the history slides shut and open under the screenshot', async ({ page }) => {
    const dialog = await openScreenshotDialog(page, MACHINE_ID);
    const history = dialog.getByText('history', { exact: true });
    await expect(history).toBeVisible();
    const slides = await recordSlides(dialog);

    await dialog.getByRole('button', { name: 'hide history' }).click();
    await expect.poll(slides).toBe('collapsible-up');
    await expect(history).toHaveCount(0);

    await dialog.getByRole('button', { name: 'show history' }).click();
    await expect.poll(slides).toBe('collapsible-up collapsible-down');
    await expect(history).toBeVisible();
  });
});
