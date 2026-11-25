/**
 * machine scope on a phone: 390x844 with touch, from the `mobile-chromium`
 * project, which matches only specs/mobile/. the journeys are in
 * specs/sites/machine-scope.spec.ts; this file holds what moves below md, where
 * the page menu and the site entries live in the nav drawer.
 *
 * a site of the file's own holds IN and OUT, and three people signed in through
 * /login: a member limited to IN, an admin limited to IN, and a member whose
 * machine scope is empty.
 *
 * every control is measured with `expectFullyWithinViewport` before it is tapped.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { seedMachine, seedMemberRow, seedSite, type TestUser } from '../../helpers/seed';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });
// every test signs in through /login, which a cold emulator can stretch past the default
test.setTimeout(60_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE = `site-scope-phone-${SUFFIX}`;
const SITE_NAME = `scope phone ${SUFFIX}`;
// no id contains another, so hasText filters stay strict
const IN = `mach-phone-in-${SUFFIX}`;
const OUT = `mach-phone-out-${SUFFIX}`;
const MACHINES = [IN, OUT];

let member: TestUser;
let admin: TestUser;
let empty: TestUser;

test.beforeAll(async () => {
  await seedSite({ id: SITE, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  // no monitors: a hardware subdoc would outlive the machine doc's delete
  for (const machineId of MACHINES) await seedMachine(SITE, machineId, { monitorCount: 0 });

  // `sites: []`: dedicatedUser puts everyone on site-A. the global role grants nothing.
  const person = (prefix: string) =>
    seedDedicatedUser({ ...dedicatedUser('member', `${prefix}-${SUFFIX}`), sites: [] });
  member = await person('phone-m');
  admin = await person('phone-a');
  empty = await person('phone-e');
  await seedMemberRow(SITE, member.uid, 'member', { machineIds: [IN] });
  await seedMemberRow(SITE, admin.uid, 'admin', { machineIds: [IN] });
  await seedMemberRow(SITE, empty.uid, 'member', { machineIds: [] });
});

test.afterAll(async () => {
  const db = getAdminDb();
  const people = [member, admin, empty];
  for (const machineId of MACHINES) await db.doc(`sites/${SITE}/machines/${machineId}`).delete();
  for (const uid of ['someone-else', ...people.map((p) => p.uid)]) {
    await db.doc(`sites/${SITE}/members/${uid}`).delete();
  }
  await db.doc(`sites/${SITE}`).delete();
  for (const p of people) {
    await db.doc(`users/${p.uid}`).delete();
    await getAdminAuth().deleteUser(p.uid);
  }
});

/** the login form mounts its password on the email's focus, which `fill()` gives it. */
async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/^email$/i).fill(user.email);
  const password = page.getByLabel(/^password$/i);
  await expect(password).toBeVisible();
  await password.fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

const card = (page: Page, machineId: string) =>
  page.getByTestId('machine-card').filter({ hasText: machineId });

/** the header's nav drawer: plain `md:hidden` markup, so it exists only at this width. */
async function openDrawer(page: Page): Promise<Locator> {
  const menu = page.getByRole('button', { name: 'menu', exact: true });
  await expectFullyWithinViewport(page, menu, 'the header menu');
  await menu.tap();
  const drawer = page.getByRole('navigation', { name: 'site and page navigation' });
  await expect(drawer).toBeVisible();
  // the site's name renders with the site entries, so it is the sign they are in
  await expect(drawer.getByTestId('drawer-site-toggle')).toContainText(SITE_NAME);
  return drawer;
}

test('a scoped member sees only their machine, and the drawer only the pages that fit it', async ({ page }) => {
  await signIn(page, member);
  await expect(card(page, IN)).toBeVisible();
  await expect(page.getByTestId('machine-card')).toHaveCount(1);
  await expect(card(page, OUT)).toHaveCount(0);
  await assertNoHorizontalOverflow(page);

  // a page's button holds its name and its description, so match from the name
  const drawer = await openDrawer(page);
  for (const name of ['dashboard', 'hoot', 'logs']) {
    const item = drawer.getByRole('button', { name: new RegExp(`^${name}`) });
    await expectFullyWithinViewport(page, item, `the drawer ${name}`);
  }
  for (const name of ['talons', 'roost', 'deploy']) {
    await expect(drawer.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0);
  }
  await assertNoHorizontalOverflow(page);
});

test('an empty machine scope says so on a phone, and offers no pairing', async ({ page }) => {
  await signIn(page, empty);
  const notice = page.getByText('no machines here for you yet', { exact: true });
  await expectFullyWithinViewport(page, notice, 'the empty-scope notice');
  await expectFullyWithinViewport(
    page,
    page.getByText('a site admin chooses which machines you can reach.', { exact: true }),
    'the notice line',
  );
  await expect(page.getByTestId('getting-started-enter-phrase')).toHaveCount(0);
  await expect(page.getByTestId('getting-started-authorize')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test("a scoped admin's drawer has no site-wide entries, and their machine's menu fits", async ({ page }) => {
  await signIn(page, admin);
  await expect(card(page, IN)).toBeVisible();
  await expect(card(page, OUT)).toHaveCount(0);

  const drawer = await openDrawer(page);
  await expect(drawer.getByRole('button', { name: 'site settings', exact: true })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: 'manage sites', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  const trigger = card(page, IN).getByTestId('machine-context-menu-trigger');
  await expectFullyWithinViewport(page, trigger, 'the machine menu button');
  await trigger.tap();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expectFullyWithinViewport(page, menu.getByTestId('machine-context-menu-reboot'), 'restart machine');
  await expectFullyWithinViewport(page, menu.getByTestId('machine-context-menu-shutdown'), 'shutdown machine');
  // revoking the token and removing the machine are site-wide
  await expect(menu.getByTestId('machine-context-menu-revoke-token')).toHaveCount(0);
  await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
});

test('a site-wide page tells a scoped member it needs the whole site, within the screen', async ({ page }) => {
  await signIn(page, member);
  await page.goto('/deployments');
  await expectFullyWithinViewport(
    page,
    page.getByText('this page needs whole-site access', { exact: true }),
    'the whole-site notice',
  );
  await assertNoHorizontalOverflow(page);
});
