/**
 * Mobile — /add machine pairing. Viewport / isMobile / hasTouch come from the
 * `mobile-chromium` project in playwright.config.ts.
 *
 * `mobile/responsive-acceptance.spec.ts` only measures /add; this one operates
 * it. Superadmin (not member) is deliberate: a member auto-selects their single
 * site, skipping the one control that needs proving on a phone — the Radix
 * `Select` whose listbox is portalled to `document.body` and so escapes every
 * layout constraint on the card.
 *
 * The agent API is stubbed (as in `onboarding/add-cli.spec.ts`): the real
 * device-code exchange needs a paired agent, and this is about the browser
 * surface, not the pairing backend.
 */

import { test, expect } from '@playwright/test';
import { assertNoHorizontalOverflow } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import { TEST_SITES } from '../../helpers/seed';

test.use(roleState('superadmin'));

const PAIR_PHRASE = 'silver-compass-drift';
const PAIRED_MACHINE_ID = 'e2e-mobile-paired-machine';
const TARGET_SITE = TEST_SITES[0];

test('pairing phrase prefills, the site picker opens, and authorize succeeds', async ({ page }) => {
  await page.route('**/api/agent/auth/device-code/authorize', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.preview) {
      expect(body).toEqual({ pairPhrase: PAIR_PHRASE, siteId: TARGET_SITE.id, preview: true });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ machineId: PAIRED_MACHINE_ID, existing: false }),
      });
      return;
    }
    expect(body).toEqual({
      pairPhrase: PAIR_PHRASE,
      siteId: TARGET_SITE.id,
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, machineId: PAIRED_MACHINE_ID }),
    });
  });

  await page.goto(`/add?code=${PAIR_PHRASE}`);
  await expect(page.getByText('add machine').first()).toBeVisible();
  await expect(page.getByLabel(/pairing phrase/i)).toHaveValue(PAIR_PHRASE);

  // Superadmin has more than one site, so nothing is pre-selected and the
  // continue button is not rendered yet.
  await expect(page.getByRole('button', { name: /^continue$/i })).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  // Radix Select: the trigger is the labelled combobox, the options land in a
  // portal outside the card.
  await page.getByLabel(/^site$/i).click();
  const option = page.getByRole('option', { name: TARGET_SITE.name, exact: true });
  await expect(option).toBeVisible();
  await assertNoHorizontalOverflow(page);
  await option.click();

  // the machine is named before anything is approved
  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page.getByTestId('add-machine-name')).toHaveText(PAIRED_MACHINE_ID);

  const authorize = page.getByRole('button', { name: /authorize machine/i });
  await expect(authorize).toBeVisible();
  await assertNoHorizontalOverflow(page);

  await authorize.click();
  await expect(page.getByRole('heading', { name: /machine authorized/i })).toBeVisible();
  await expect(page.getByText(PAIRED_MACHINE_ID)).toBeVisible();
  await expect(page.getByRole('button', { name: /go to dashboard/i })).toBeVisible();
  await assertNoHorizontalOverflow(page);
});
