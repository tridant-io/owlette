/**
 * sites — the site switcher's filter, past ten sites.
 *
 * a superadmin sees every site, and this file seeds twelve of its own on top
 * of the baseline. the header's switcher opens on a filter, part of one name
 * narrows it to that site, and picking it switches the dashboard there; escape
 * clears the filter before it closes the switcher. owlette swoop's picker
 * (`/swoop`) has the same filter in its site list, where enter picks the first
 * match. keys are pressed one at a time, as a person types them: a menu takes
 * a typed key as typeahead unless the filter keeps it. the filter is a search
 * row whose x clears it; the report keeps pictures of the open switcher, dark
 * and light, and of swoop's list, because the look is the owner's to judge.
 *
 * the sites are released after the file and the superadmin's saved site put
 * back: the suite runs one worker, so either would carry into later specs.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { releaseFixtureSite, seedSite, TEST_USERS } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SUFFIX = crypto.randomBytes(4).toString('hex');
const WORDS = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'island', 'juniper', 'kestrel', 'lagoon'];
// the suffix keeps every name to this run, so a typed part of one matches nothing an earlier run left
const SITES = WORDS.map((word) => ({ id: `switcher-${word}-${SUFFIX}`, name: `Switcher ${word} ${SUFFIX}` }));
const KESTREL = SITES[WORDS.indexOf('kestrel')];
const LAGOON = SITES[WORDS.indexOf('lagoon')];
const OWNER = 'someone-else';

const userDoc = () => getAdminDb().collection('users').doc(TEST_USERS.superadmin.uid);
const savedSiteId = async () => (await userDoc().get()).get('lastSiteId') as string | undefined;
let savedBefore: string | undefined;

test.beforeAll(async () => {
  savedBefore = await savedSiteId();
  await Promise.all(SITES.map((site) => seedSite({ ...site, owner: OWNER, timezone: 'UTC' })));
});

test.afterAll(async () => {
  await userDoc().update({ lastSiteId: savedBefore ?? FieldValue.delete() });
  await Promise.all(SITES.map((site) => releaseFixtureSite(site.id, OWNER)));
});

// this run's sites, in the open switcher
const runSites = (page: Page) => page.getByRole('menu').getByRole('menuitem', { name: new RegExp(SUFFIX) });

async function openSwitcher(page: Page) {
  await page.goto('/dashboard');
  await page.getByTestId('site-switcher-trigger').click();
  const filter = page.getByRole('menu').getByRole('textbox', { name: 'filter sites', exact: true });
  await expect(filter).toBeFocused();
  await expect(runSites(page)).toHaveCount(SITES.length);
  return filter;
}

// the open surface and 16 px around it, so its edges and shadow are in the picture
async function attachPicture(page: Page, surface: Locator, name: string) {
  const box = (await surface.boundingBox())!;
  const clip = { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
  await test.info().attach(name, { body: await page.screenshot({ clip }), contentType: 'image/png' });
}

test("the header's switcher opens on a filter, and picking a match switches to that site", async ({ page }) => {
  const filter = await openSwitcher(page);

  await filter.pressSequentially(`kestrel ${SUFFIX}`);

  await expect(filter).toHaveValue(`kestrel ${SUFFIX}`);
  await expect(runSites(page)).toHaveCount(1);
  await expect(page.getByRole('menuitem', { name: 'Site A (Assigned)' })).toHaveCount(0);
  const match = page.getByRole('menuitem', { name: KESTREL.name, exact: true });
  await expect(match.locator('mark')).toHaveText(`kestrel ${SUFFIX}`);

  const menu = page.getByRole('menu');
  const clear = menu.getByRole('button', { name: 'clear filter' });
  await expect(clear).toBeVisible();
  await attachPicture(page, menu, 'switcher filter, dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
  await expect(clear).toBeVisible();
  await attachPicture(page, menu, 'switcher filter, light');

  await clear.click();

  await expect(runSites(page)).toHaveCount(SITES.length);

  await match.click();

  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('site-switcher-trigger')).toContainText(KESTREL.name);
  // the header saves the site from the browser, unawaited: wait for it, or it
  // could land after afterAll has put the old one back
  await expect.poll(savedSiteId).toBe(KESTREL.id);
});

test("escape clears the switcher's filter first, then closes the switcher", async ({ page }) => {
  const filter = await openSwitcher(page);
  await filter.pressSequentially('lagoon');
  await expect(runSites(page)).toHaveCount(1);

  await filter.press('Escape');

  await expect(filter).toHaveValue('');
  await expect(runSites(page)).toHaveCount(SITES.length);

  await filter.press('Escape');

  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByTestId('site-switcher-trigger')).toBeFocused();
});

test("owlette swoop's picker has the same filter in its site list, and enter picks the first match", async ({ page }) => {
  await page.goto('/swoop');
  const trigger = page.getByTestId('swoop-picker-site');
  await trigger.click();

  const list = page.getByRole('dialog', { name: 'sites', exact: true });
  const filter = list.getByRole('textbox', { name: 'filter sites', exact: true });
  await expect(filter).toBeFocused();
  await filter.pressSequentially(`lagoon ${SUFFIX}`);
  // this run's sites: the filter's x is a button in the list too
  await expect(list.getByRole('button', { name: new RegExp(SUFFIX) })).toHaveCount(1);
  await expect(list.getByRole('button', { name: LAGOON.name, exact: true })).toBeVisible();
  await attachPicture(page, list, 'picker site list, dark');

  await filter.press('Enter');

  await expect(list).toHaveCount(0);
  await expect(trigger).toContainText(LAGOON.name);
  await expect(page.getByText('no machines in this site yet')).toBeVisible();
  await expect.poll(savedSiteId).toBe(LAGOON.id);
});
