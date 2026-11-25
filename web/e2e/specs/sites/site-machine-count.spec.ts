/**
 * sites — the machine count at the end of each row in the header's site switcher,
 * and in owlette swoop's site list. the phone drawer's is in
 * specs/mobile/menus-and-inputs.spec.ts.
 *
 * the count is read from the server when the switcher opens, so this proves
 * the rules let each kind of person count: a superadmin, who sees every site,
 * and a member of the whole of two sites of the spec's own, one holding two
 * machines and one none. a scoped admin's count, which is only the machines
 * they reach, is in machine-scope.spec.ts. the report keeps pictures of the
 * open switcher, dark and light, because the look is the owner's to judge.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { attachPicture } from '../../helpers/picture';
import { signIn } from '../../helpers/plans';
import { roleState } from '../../helpers/roles';
import { releaseFixtureSite, seedMachine, seedMemberRow, seedSite, type TestUser } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const OWNER = 'someone-else';
const TWO = { id: `site-count-two-${SUFFIX}`, name: `count two ${SUFFIX}` };
const NONE = { id: `site-count-none-${SUFFIX}`, name: `count none ${SUFFIX}` };
const MACHINES = [`mach-count-a-${SUFFIX}`, `mach-count-b-${SUFFIX}`];

let member: TestUser;

test.beforeAll(async () => {
  for (const site of [TWO, NONE]) await seedSite({ ...site, owner: OWNER, timezone: 'UTC' });
  // no monitors: a hardware subdoc would outlive the machine doc's delete
  for (const machineId of MACHINES) await seedMachine(TWO.id, machineId, { monitorCount: 0 });
  // `sites: []`: dedicatedUser puts everyone on site-A
  member = await seedDedicatedUser({ ...dedicatedUser('member', `count-${SUFFIX}`), sites: [] });
  for (const site of [TWO, NONE]) await seedMemberRow(site.id, member.uid, 'member');
});

test.afterAll(async () => {
  const db = getAdminDb();
  for (const machineId of MACHINES) await db.doc(`sites/${TWO.id}/machines/${machineId}`).delete();
  for (const site of [TWO, NONE]) {
    await db.doc(`sites/${site.id}/members/${member.uid}`).delete();
    await releaseFixtureSite(site.id, OWNER);
  }
  await db.doc(`users/${member.uid}`).delete();
  await getAdminAuth().deleteUser(member.uid);
});

async function openSwitcher(page: Page): Promise<Locator> {
  await page.getByTestId('site-switcher-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: `${TWO.name} 2 machines`, exact: true })).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: `${NONE.name} 0 machines`, exact: true })).toHaveCount(1);
  return menu;
}

test.describe('as a member of the whole site', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // signing in through /login, which a cold emulator can stretch past the default
  test.setTimeout(60_000);

  test("each site's row ends with how many machines it holds", async ({ page }) => {
    await signIn(page, member);

    const menu = await openSwitcher(page);

    await menu.getByRole('menuitem', { name: TWO.name }).hover();
    await attachPicture(page, menu, 'switcher counts, member, dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await attachPicture(page, menu, 'switcher counts, member, light');
  });
});

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('every site in the switcher has its count, the seeded ones included', async ({ page }) => {
    await page.goto('/dashboard');

    const menu = await openSwitcher(page);

    const sites = menu.locator('[data-site-item]');
    await expect(sites.first()).toBeVisible();
    await expect(sites.filter({ has: page.locator('[data-slot="badge"]') })).toHaveCount(await sites.count());
    await attachPicture(page, menu, 'switcher counts, superadmin, dark');
  });

  test("owlette swoop's site list has the same counts", async ({ page }) => {
    await page.goto('/swoop');
    await page.getByTestId('swoop-picker-site').click();

    const list = page.getByRole('dialog', { name: 'sites', exact: true });
    await expect(list.getByRole('button', { name: `${TWO.name} 2 machines`, exact: true })).toHaveCount(1);
    await expect(list.getByRole('button', { name: `${NONE.name} 0 machines`, exact: true })).toHaveCount(1);
  });
});
