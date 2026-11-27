/**
 * sites: a machine's state in the machines section of a site's settings
 * (`/admin/sites/{siteId}?section=machines`) reads as the dashboard's pill does.
 *
 * an agent that died without writing `online: false` leaves the flag stuck true;
 * only its heartbeat, 18 days old here, shows the machine is gone. the row says
 * when it was last seen, not `online`, and offers no restart. a machine its
 * agent marked asleep says `asleep`, through a fresh heartbeat as well.
 *
 * the site and its machines are the spec's own; afterAll deletes them.
 */

import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { releaseFixtureSite, seedMachine, seedSite } from '../../helpers/seed';

// sorts after site-A by name, so it never becomes a fixture's current site
const SITE = { id: 'site-online-state', name: 'Site Online State' };

// no id holds another, or the word a row is checked for
const FRESH = 'e2e-state-fresh';
const STUCK = 'e2e-state-stuck';
const ASLEEP = 'e2e-state-asleep';
const MACHINES = [FRESH, STUCK, ASLEEP];
const DAY_MS = 24 * 60 * 60 * 1000;

test.use(roleState('superadmin'));

const machinePath = (machineId: string) => `sites/${SITE.id}/machines/${machineId}`;
const machinesPanel = (page: Page) => page.getByRole('region', { name: 'machines', exact: true });
const row = (page: Page, machineId: string) =>
  machinesPanel(page).getByRole('listitem').filter({ hasText: machineId });
const restart = (page: Page, machineId: string) =>
  row(page, machineId).getByRole('button', { name: `restart ${machineId}`, exact: true });

test.beforeAll(async () => {
  await seedSite({ ...SITE, owner: 'someone-else' });
  // no monitors, so no display subdocument outlives afterAll
  await Promise.all(MACHINES.map((id) => seedMachine(SITE.id, id, { monitorCount: 0 })));
  // what a killed agent leaves: `online: true` (seedMachine's) and its last heartbeat,
  // a server timestamp as the agent stamps it
  await getAdminDb()
    .doc(machinePath(STUCK))
    .set({ lastHeartbeat: Timestamp.fromMillis(Date.now() - 18 * DAY_MS) }, { merge: true });
  await getAdminDb().doc(machinePath(ASLEEP)).set({ osFamily: 'macos', asleep: true }, { merge: true });
});

test.afterAll(async () => {
  await Promise.all(MACHINES.map((id) => getAdminDb().doc(machinePath(id)).delete()));
  await releaseFixtureSite(SITE.id, 'someone-else');
});

test('a machine whose agent died reads last seen, not online, and an asleep one reads asleep', async ({ page }) => {
  await page.goto(`/admin/sites/${SITE.id}?section=machines`);
  await expect(machinesPanel(page)).toBeVisible();

  await expect(row(page, FRESH).getByText('online', { exact: true })).toBeVisible();
  await expect(restart(page, FRESH)).toBeEnabled();

  await expect(row(page, STUCK).getByText('last seen 18d ago', { exact: true })).toBeVisible();
  await expect(row(page, STUCK).getByText('online', { exact: true })).toHaveCount(0);
  await expect(restart(page, STUCK)).toBeDisabled();

  await expect(row(page, ASLEEP).getByText('asleep', { exact: true })).toBeVisible();
  await expect(row(page, ASLEEP).getByText('online', { exact: true })).toHaveCount(0);
  await expect(restart(page, ASLEEP)).toBeDisabled();
});
