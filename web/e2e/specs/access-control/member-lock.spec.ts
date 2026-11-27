/**
 * a superadmin who isn't a member of the site in view (adr 0021). super-uid holds
 * no member row on this spec's site, so:
 *   - the dashboard and the site's settings carry the one hint, "add yourself to
 *     this site to change it", linking to their own site access;
 *   - what the server would refuse them is hidden or disabled, and sends nothing;
 *   - what it allows stays: restarting the machine queues the command;
 *   - /logs draws no crash screenshot, which the image route would refuse;
 *   - /add offers only the sites they are a member of.
 * the site sorts after the baseline's, and the saved site goes back afterwards,
 * so no later superadmin spec opens on it.
 */

import { test, expect, type Page } from '@playwright/test';
import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { clearSiteLogs, seedLogEvents, setLastSite } from '../../helpers/coverageSeed';
import { seedMachineWithProcesses } from '../../helpers/processConfig';
import { releaseFixtureSite, revokeMembership, seedMemberRow, seedSite, TEST_SITES, TEST_USERS } from '../../helpers/seed';

test.use(roleState('superadmin'));

const SUPER_UID = TEST_USERS.superadmin.uid;
const SITE_ID = 'e2e-member-lock';
const SITE_NAME = 'Site Lock (e2e)';
const SITE_OWNER = 'someone-else';
const MACHINE_ID = 'e2e-member-lock-machine';
const PROCESS_NAME = 'e2e-lock-show';
const HINT = 'add yourself to this site to change it';
const ADD_YOURSELF = '/admin/users?sites=me';
const IMAGE_ROUTE = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/screenshots/image?path=${encodeURIComponent(
  `screenshots/${SITE_ID}/${MACHINE_ID}/1700000000000-aabbccdd.jpg`,
)}`;

let savedSite: string | undefined;

test.beforeAll(async () => {
  const user = await getAdminDb().collection('users').doc(SUPER_UID).get();
  savedSite = user.data()?.lastSiteId;
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: SITE_OWNER, timezone: 'UTC' });
  await seedMachineWithProcesses(SITE_ID, MACHINE_ID, [
    { id: 'e2e-lock-proc', name: PROCESS_NAME, launch_mode: 'always', status: 'RUNNING', pid: 4242 },
  ]);
});

test.beforeEach(async () => {
  await setLastSite(SUPER_UID, SITE_ID);
});

test.afterAll(async () => {
  const db = getAdminDb();
  await clearSiteLogs(SITE_ID);
  const commands = await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).collection('commands').get();
  await Promise.all(commands.docs.map((d) => d.ref.delete()));
  await db.collection('sites').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
  await db.collection('config').doc(SITE_ID).collection('machines').doc(MACHINE_ID).delete();
  await releaseFixtureSite(SITE_ID, SITE_OWNER);
  await db
    .collection('users')
    .doc(SUPER_UID)
    .set({ lastSiteId: savedSite ?? FieldValue.delete() }, { merge: true });
});

/** every request that would change something, from the moment it is called. refreshing the session cookie changes nothing */
function changesSent(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && pathname.startsWith('/api/') && pathname !== '/api/auth/session') {
      sent.push(`${request.method()} ${pathname}`);
    }
  });
  return sent;
}

async function expectHint(page: Page): Promise<void> {
  const lock = page.getByTestId('member-lock');
  await expect(lock).toContainText(HINT);
  await expect(lock.getByRole('link', { name: 'add yourself' })).toHaveAttribute('href', ADD_YOURSELF);
}

test('the dashboard hides what the server refuses, and killing a process and restarting the machine still work', async ({ page }) => {
  const sent = changesSent(page);
  await page.goto('/dashboard');
  await expect(page.getByTestId('site-switcher-trigger')).toContainText(SITE_NAME);
  await expectHint(page);

  const card = page.getByTestId('machine-card').filter({ hasText: MACHINE_ID });
  await expect(card).toBeVisible();
  // the process runs and stops from here; its configuration does not change
  await expect(card.getByRole('button', { name: `restart ${PROCESS_NAME}` })).toBeEnabled();
  await expect(card.getByRole('button', { name: `kill ${PROCESS_NAME}` })).toBeEnabled();
  await expect(card.getByRole('button', { name: `edit ${PROCESS_NAME}` })).toHaveCount(0);
  await expect(card.getByRole('button', { name: `duplicate ${PROCESS_NAME}` })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'add process' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /add machine/ })).toHaveCount(0);

  await card.getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
  await expect(menu.getByTestId('machine-context-menu-revoke-token')).toBeVisible();
  await expect(menu.getByTestId('machine-context-menu-shutdown')).toHaveCount(0);
  await expect(menu.getByTestId('machine-context-menu-schedule-restarts-gear')).toHaveCount(0);
  await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(sent).toEqual([]);

  await card.getByRole('button', { name: `kill ${PROCESS_NAME}` }).click();
  const kill = page.getByRole('dialog', { name: 'kill process' });
  await kill.getByRole('button', { name: 'kill process', exact: true }).click();
  await expect(page.getByText(`Kill command sent for "${PROCESS_NAME}"`)).toBeVisible({ timeout: 10_000 });

  await card.getByTestId('machine-context-menu-trigger').click();
  await page.getByRole('menu').getByTestId('machine-context-menu-reboot').click();
  const restart = page.getByRole('dialog', { name: `restart ${MACHINE_ID}?` });
  await restart.getByRole('button', { name: 'restart', exact: true }).click();
  await expect(page.getByText(`restart command sent to ${MACHINE_ID}`)).toBeVisible({ timeout: 10_000 });

  const pending = await getAdminDb()
    .collection('sites').doc(SITE_ID)
    .collection('machines').doc(MACHINE_ID)
    .collection('commands').doc('pending')
    .get();
  const queued = Object.values((pending.data() ?? {}) as Record<string, { type?: string }>);
  expect(queued.map((cmd) => cmd.type).sort()).toEqual(['kill_process', 'reboot_machine']);
});

test("the site's settings read, offer nothing to save and send nothing", async ({ page }) => {
  const sent = changesSent(page);
  // the danger zone is the owner's, and they are no owner here: the page falls back to general
  await page.goto(`/admin/sites/${SITE_ID}?section=danger`);
  await expect(page.getByRole('heading', { level: 1, name: SITE_NAME, exact: true })).toBeVisible();
  await expectHint(page);

  // the values read, the inputs are disabled, and the action is hidden as a role-locked one is
  const name = page.getByLabel('site name');
  await expect(name).toHaveValue(SITE_NAME);
  await expect(name).toBeDisabled();
  await expect(page.getByRole('button', { name: 'save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'danger zone', exact: true })).toHaveCount(0);

  await page.goto(`/admin/sites/${SITE_ID}?section=members`);
  await expectHint(page);
  await expect(page.getByRole('button', { name: 'add member', exact: true })).toHaveCount(0);

  // restarting a machine is theirs to do; moving, removing and the site's display setting are not
  await page.goto(`/admin/sites/${SITE_ID}?section=machines`);
  await expectHint(page);
  await expect(page.getByRole('switch', { name: 'keep screens awake' })).toBeDisabled();
  await expect(page.getByRole('button', { name: `restart ${MACHINE_ID}` })).toBeEnabled();
  await expect(page.getByRole('button', { name: `move ${MACHINE_ID}` })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `remove ${MACHINE_ID}` })).toHaveCount(0);
  expect(sent).toEqual([]);
});

for (const { path, create } of [
  { path: '/admin/alerts', create: 'create rule' },
  { path: '/admin/schedules', create: 'create preset' },
  { path: '/admin/webhooks', create: 'add webhook' },
  { path: '/admin/hoot', create: null },
]) {
  test(`${path} says how to add yourself and offers nothing to create`, async ({ page }) => {
    await page.goto(path);
    await expectHint(page);
    if (create) await expect(page.getByRole('button', { name: create, exact: true })).toHaveCount(0);
    if (path === '/admin/alerts') await expect(page.getByRole('button', { name: /presets/ })).toHaveCount(0);
  });
}

test("an alert rule reads, and its row offers neither edit nor delete", async ({ page }) => {
  const alerts = getAdminDb().collection('sites').doc(SITE_ID).collection('settings').doc('alerts');
  await alerts.set({
    rules: [
      {
        id: 'e2e-lock-rule',
        name: 'e2e lock rule',
        metric: 'cpu_percent',
        operator: '>',
        value: 80,
        severity: 'warning',
        channels: ['email'],
        enabled: true,
        cooldownMinutes: 30,
      },
    ],
  });
  try {
    await page.goto('/admin/alerts');
    await expectHint(page);
    await expect(page.getByText('e2e lock rule')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'enable e2e lock rule' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'edit e2e lock rule' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'delete e2e lock rule' })).toHaveCount(0);
    // the row is clickable for a member, where it opens the editor
    await page.getByText('e2e lock rule').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await alerts.delete();
  }
});

test('/logs draws no crash screenshot the image route would refuse', async ({ page }) => {
  await seedLogEvents(SITE_ID, [
    {
      id: 'e2e-lock-crash',
      action: 'process_crash',
      level: 'error',
      machineId: MACHINE_ID,
      processName: PROCESS_NAME,
      details: `${PROCESS_NAME} crashed with exit code 1`,
      screenshotUrl: IMAGE_ROUTE,
    },
  ]);
  const imageRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/screenshots/image')) imageRequests.push(request.url());
  });

  await page.goto('/logs');
  await expect(page.getByTestId('site-switcher-trigger')).toContainText(SITE_NAME);
  await expectHint(page);
  await page.getByTestId('log-row-e2e-lock-crash').click();
  await expect(page.getByText(`${PROCESS_NAME} crashed with exit code 1`).first()).toBeVisible();

  await expect(page.getByRole('button', { name: 'crash screenshot' })).toHaveCount(0);
  await expect(page.getByTestId('logs-clear')).toHaveCount(0);
  expect(imageRequests).toEqual([]);
});

test.describe('/add', () => {
  const memberOf = [TEST_SITES[1], TEST_SITES[2]];

  test.beforeAll(async () => {
    for (const site of memberOf) await seedMemberRow(site.id, SUPER_UID, 'admin');
  });

  test.afterAll(async () => {
    for (const site of memberOf) await revokeMembership(site.id, SUPER_UID);
  });

  test('offers only the sites they are a member of', async ({ page }) => {
    await page.goto('/add?code=silver-compass-drift');
    await page.getByLabel(/^site$/i).click();
    const options = page.getByRole('option');
    for (const site of memberOf) await expect(options.filter({ hasText: site.name })).toHaveCount(1);
    await expect(options.filter({ hasText: SITE_NAME })).toHaveCount(0);
    await expect(options.filter({ hasText: TEST_SITES[0].name })).toHaveCount(0);
  });
});

test('the hint opens their own site access', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByTestId('member-lock').getByRole('link', { name: 'add yourself' }).click();
  await expect(page).toHaveURL(/\/admin\/users\?sites=me$/);
  const dialog = page.getByRole('dialog', { name: 'manage site access' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(TEST_USERS.superadmin.email);
});
