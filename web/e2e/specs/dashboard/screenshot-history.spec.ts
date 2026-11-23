/**
 * the screenshot dialog's history slides open and shut, as the other panels do. from
 * md it is a sidebar on the left, so it slides across; below md it stacks under the
 * screenshot and slides down (mobile/screenshot-dialog.spec.ts).
 */

import { test, expect } from '@playwright/test';
import { roleState } from '../../helpers/roles';
import { TEST_SITES } from '../../helpers/seed';
import { openScreenshotDialog, removeScreenshotMachine, seedScreenshotMachine } from '../../helpers/screenshotDialog';
import { recordSlides } from '../../helpers/slide';

const SITE_ID = TEST_SITES[0].id;
const MACHINE_ID = 'e2e-screenshot-history-machine';
const SHOT_ID = 'e2e-history-shot-1';

test.use(roleState('admin'));

test.beforeAll(() => seedScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));
test.afterAll(() => removeScreenshotMachine(SITE_ID, MACHINE_ID, SHOT_ID));

test('the history sidebar slides shut and open across', async ({ page }) => {
  const dialog = await openScreenshotDialog(page, MACHINE_ID);
  const history = dialog.getByText('history', { exact: true });
  await expect(history).toBeVisible();
  const slides = await recordSlides(dialog);

  await dialog.getByRole('button', { name: 'hide history' }).click();
  await expect.poll(slides).toBe('collapsible-left');
  await expect(history).toHaveCount(0);

  await dialog.getByRole('button', { name: 'show history' }).click();
  await expect.poll(slides).toBe('collapsible-left collapsible-right');
  await expect(history).toBeVisible();
});
