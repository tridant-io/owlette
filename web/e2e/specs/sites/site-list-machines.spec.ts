/**
 * sites: the machines column of admin panel → sites (`/admin/sites`), read from
 * one `GET /api/sites?include=machines`.
 *
 * a site of the spec's own holds four machines (one with a config document,
 * which is no machine): one live, one whose agent died
 * with the flag stuck online and an 18-day-old heartbeat (a Timestamp, as the
 * agent stamps it), one asleep, and one an older agent wrote whose name lives only
 * in the legacy field. a superadmin, who is no member of
 * it, reads 4 with 1 offline and 1 asleep, and the card lists the dead one as
 * last seen 18d ago, not online. a member limited to two of the machines (and
 * an id with no machine) reads 2, the count the site switcher gives them. a
 * phone puts the count on the row's second line with no card, and a tap opens
 * the card on a tablet, where a tooltip would ignore it.
 *
 * the report keeps pictures of the open card, dark and light. afterAll deletes
 * the sites, machines, member rows and the member.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { attachPicture } from '../../helpers/picture';
import { signIn } from '../../helpers/plans';
import { roleState } from '../../helpers/roles';
import { grantMembership, releaseFixtureSite, seedMachine, seedSite, type TestUser } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const OWNER = 'someone-else';
// both sort after the baseline's Site A..C by name, so neither becomes a fixture's current site
const SITE = { id: `site-mcol-${SUFFIX}`, name: `Site Machines Column ${SUFFIX}` };
const HOME = { id: `site-mcol-home-${SUFFIX}`, name: `Site Machines Home ${SUFFIX}` };
// no id holds another, or a word a row is checked for
const FRESH = `mach-mcol-fresh-${SUFFIX}`;
const STUCK = `mach-mcol-stuck-${SUFFIX}`;
const ASLEEP = `mach-mcol-asleep-${SUFFIX}`;
const LEGACY = `mach-mcol-legacy-${SUFFIX}`;
const LEGACY_NAME = `mach-mcol-old-agent-${SUFFIX}`;
const MACHINES = [FRESH, STUCK, ASLEEP, LEGACY];
const DAY_MS = 24 * 60 * 60 * 1000;

let scoped: TestUser;

const machinePath = (machineId: string) => `sites/${SITE.id}/machines/${machineId}`;
const configPath = (machineId: string) => `config/${SITE.id}/machines/${machineId}`;
const rowOf = (page: Page, siteName: string) =>
  page.getByRole('list', { name: 'sites', exact: true }).getByRole('listitem').filter({ hasText: siteName });

test.beforeAll(async () => {
  const db = getAdminDb();
  for (const site of [SITE, HOME]) await seedSite({ ...site, owner: OWNER, timezone: 'UTC' });
  // no monitors: a display subdocument would outlive the machine doc's delete
  for (const id of [FRESH, STUCK, ASLEEP]) await seedMachine(SITE.id, id, { monitorCount: 0 });
  // what a killed agent leaves: `online: true` (seedMachine's) and its last heartbeat
  await db.doc(machinePath(STUCK)).set({ lastHeartbeat: Timestamp.fromMillis(Date.now() - 18 * DAY_MS) }, { merge: true });
  await db.doc(machinePath(ASLEEP)).set({ osFamily: 'macos', asleep: true }, { merge: true });
  // a superadmin's collection-group read must not count this `machines` document as a machine
  await db.doc(configPath(FRESH)).set({ processes: [] });
  // an older agent's name field, so the api's field selection must carry the fallback
  await db.doc(machinePath(LEGACY)).set({
    machine_name: LEGACY_NAME,
    online: true,
    lastHeartbeat: Timestamp.now(),
    agent_version: '3.3.7',
  });
  // an admin of HOME whole, which opens the admin panel, and a member of SITE limited
  // to FRESH, STUCK and an id with no machine
  scoped = await seedDedicatedUser({ ...dedicatedUser('member', `mcol-${SUFFIX}`), sites: [] });
  await grantMembership(HOME.id, scoped.uid, 'admin');
  await grantMembership(SITE.id, scoped.uid, 'member', { machineIds: [FRESH, STUCK, `mach-mcol-gone-${SUFFIX}`] });
});

test.afterAll(async () => {
  const db = getAdminDb();
  await Promise.all([...MACHINES.map((id) => db.doc(machinePath(id)).delete()), db.doc(configPath(FRESH)).delete()]);
  for (const site of [SITE, HOME]) {
    await releaseFixtureSite(site.id, scoped.uid);
    await releaseFixtureSite(site.id, OWNER);
  }
  await db.doc(`users/${scoped.uid}`).delete();
  await getAdminAuth().deleteUser(scoped.uid);
});

/** the machines cell of a site's row, md up, by the summary it reads out */
const cellOf = (page: Page, siteName: string, label: string): Locator =>
  rowOf(page, siteName).getByRole('button', { name: label, exact: true });

async function openCard(page: Page, cell: Locator): Promise<Locator> {
  await cell.hover();
  const card = page.getByRole('tooltip');
  await expect(card).toBeVisible();
  return card;
}

test.describe('as a superadmin, on a site they are no member of', () => {
  test.use(roleState('superadmin'));

  test('the cell counts every machine and what is not online, and the card reads the dead agent offline', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin/sites');

    const cell = cellOf(page, SITE.name, '4 machines: 2 online, 1 asleep, 1 offline');
    await expect(cell).toBeVisible();
    await expect(cell).toHaveText('41 offline1 asleep');

    const card = await openCard(page, cell);
    await expect(card).toContainText(SITE.name);
    await expect(card).toContainText('2 of 4 online');
    const rows = card.getByRole('listitem');
    // offline first, then asleep, then online by name; the older agent's name comes through
    await expect(rows).toHaveText([
      new RegExp(`^${STUCK}last seen 18d agov2\\.9\\.0$`),
      new RegExp(`^${ASLEEP}asleepv2\\.9\\.0$`),
      new RegExp(`^${FRESH}onlinev2\\.9\\.0$`),
      new RegExp(`^${LEGACY_NAME}onlinev3\\.3\\.7$`),
    ]);
    await expect(rows.filter({ hasText: STUCK }).getByText('online', { exact: true })).toHaveCount(0);

    await attachPicture(page, card, 'machines card, superadmin, dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await attachPicture(page, card, 'machines card, superadmin, light');

    // the card closes once the pointer leaves it, and the cell leads nowhere
    await page.mouse.move(0, 0);
    await expect(card).toHaveCount(0);
    await cell.click();
    await expect(page).toHaveURL(/\/admin\/sites$/);
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("the row's second line carries the count and what is not online, with no card", async ({ page }) => {
      await page.goto('/admin/sites');

      // what shows, in order: the md-up cell is in the dom too, hidden
      const line = (siteId: string, machines: string) =>
        new RegExp(`${siteId}\\s*·\\s*UTC\\s*·\\s*${machines}\\s*·`);
      const row = rowOf(page, SITE.name);
      await expect(row).toHaveText(line(SITE.id, '4 machines\\s*1 offline\\s*1 asleep'), { useInnerText: true });
      await expect(row.getByText('1 offline', { exact: true }).filter({ visible: true })).toHaveClass(/text-danger/);
      await expect(row.getByRole('button', { name: /machines/ })).toHaveCount(0);
      await expect(rowOf(page, HOME.name)).toHaveText(line(HOME.id, 'no machines'), { useInnerText: true });
    });
  });

  test.describe('on a tablet', () => {
    test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true });

    test('a tap opens the card and a second tap closes it', async ({ page }) => {
      await page.goto('/admin/sites');

      const cell = cellOf(page, SITE.name, '4 machines: 2 online, 1 asleep, 1 offline');
      await cell.tap();
      await expect(page.getByRole('tooltip')).toContainText('2 of 4 online');

      await cell.tap();
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    });
  });
});

test.describe('as a member limited to some machines', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  // signing in through /login, which a cold emulator can stretch past the default
  test.setTimeout(60_000);

  test('the cell counts only the machines they reach, as the site switcher does', async ({ page }) => {
    await signIn(page, scoped);

    await page.getByTestId('site-switcher-trigger').click();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: `${SITE.name} 2 machines`, exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');

    await page.goto('/admin/sites');
    const cell = cellOf(page, SITE.name, '2 machines: 1 online, 1 offline');
    await expect(cell).toBeVisible();
    const card = await openCard(page, cell);
    await expect(card.getByRole('listitem')).toHaveText([
      new RegExp(`^${STUCK}last seen 18d ago`),
      new RegExp(`^${FRESH}online`),
    ]);
    await expect(rowOf(page, HOME.name).getByTitle('no machines on this site')).toHaveText('0no machines');
  });
});
