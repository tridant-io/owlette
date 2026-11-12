/**
 * Admin — the sidebar's swoop section: its live sessions page and its settings
 * page.
 *
 * Settings is one table, a row per site the caller may change with its swoop
 * switch, which writes `sites/{site}/settings/swoop` at once.
 *
 * Session records are server-only (`sites/{site}/machines/{m}/swoop_sessions/{sid}`,
 * no rule reaches them), so the page reads them through
 * `/api/sites/{siteId}/swoop/sessions` per site and kills through the machine's
 * own `swoop/kill` route with the row's sid. The emulator has no signal worker,
 * so every kill here takes the queued `swoop_kill` command path.
 *
 * The record is written straight through the Admin SDK with the store's shape:
 * minting one for real needs a totp step-up (`swoop/session.spec.ts`), and
 * nothing on this page depends on how the session started. It is rewritten
 * live before each test, so the absence check never passes on a record the
 * kill test already ended.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { roleState } from '../../helpers/roles';
import { seedMachine, seedSite, type TestUser } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `site-admin-swoop-${SUFFIX}`;
const SITE_OWNER = 'someone-else';
const MACHINE_ID = `mach-admin-swoop-${SUFFIX}`;
const SID = `sid-admin-swoop-${SUFFIX}`;
const SITE_NAME = `Swoop admin ${SUFFIX}`;
const MACHINE_PATH = `sites/${SITE_ID}/machines/${MACHINE_ID}`;

let viewer: TestUser;

const sessionDoc = () => getAdminDb().doc(`${MACHINE_PATH}/swoop_sessions/${SID}`);

test.beforeAll(async () => {
  await seedSite({ id: SITE_ID, name: SITE_NAME, owner: SITE_OWNER, timezone: 'UTC' });
  // no monitors: a hardware subdoc would outlive the machine doc's delete.
  await seedMachine(SITE_ID, MACHINE_ID, { monitorCount: 0 });
  // a viewer of this site's machine is a member of this site, not of site-A.
  viewer = await seedDedicatedUser({ ...dedicatedUser('member', `swoop-admin-${SUFFIX}`), sites: [SITE_ID] });
});

test.beforeEach(async () => {
  const now = Date.now();
  await sessionDoc().set({
    sid: SID,
    siteId: SITE_ID,
    machineId: MACHINE_ID,
    state: 'live',
    createdBy: `user:${viewer.uid}`,
    startedAt: now,
    viewers: [
      { viewerId: `viewer-${SUFFIX}`, uid: viewer.uid, ctl: true, joinedAt: now, leaseExpiresAt: now + 300_000 },
    ],
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  await sessionDoc().delete();
  // the kill writes these two beside the session.
  await db.doc(`${MACHINE_PATH}/swoop_step_up_revocations/current`).delete();
  await db.doc(`${MACHINE_PATH}/commands/pending`).delete();
  await db.doc(MACHINE_PATH).delete();
  // the settings test's switch writes this one.
  await db.doc(`sites/${SITE_ID}/settings/swoop`).delete();
  await db.doc(`sites/${SITE_ID}/members/${SITE_OWNER}`).delete();
  await db.doc(`sites/${SITE_ID}/members/${viewer.uid}`).delete();
  await db.doc(`sites/${SITE_ID}`).delete();
  await db.doc(`users/${viewer.uid}`).delete();
  await getAdminAuth().deleteUser(viewer.uid);
});

/** the sidebar's links in one of its sections, in order. */
function sidebarSection(page: Page, name: string) {
  return page.locator('#admin-sidebar').getByRole('group', { name, exact: true }).getByRole('link');
}

async function gotoSwoopSessions(page: Page) {
  await page.goto('/admin/swoop');
  // 10s: RequireAdminAccess shows a "verifying permissions..." gate while
  // AuthContext hydrates against the auth emulator, and the default 5s races
  // that on cold-emulator runs.
  await expect(page.getByRole('heading', { name: 'swoop', exact: true })).toBeVisible({ timeout: 10_000 });
  // one round over every site the user can see, then the table or the empty state.
  await expect(page.getByText('loading sessions...')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('as a superadmin', () => {
  test.use(roleState('superadmin'));

  test('lists the live session with its viewer and ends it with a kill', async ({ page }) => {
    await gotoSwoopSessions(page);

    const row = page.getByRole('row', { name: new RegExp(MACHINE_ID) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(viewer.email);
    await expect(row.getByText('control', { exact: true })).toBeVisible();
    await expect(row).toContainText('live');

    await row.getByRole('button', { name: 'kill', exact: true }).click();
    const confirmDialog = page.getByRole('dialog', { name: 'end this session?' });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(MACHINE_ID);
    await confirmDialog.getByRole('button', { name: 'end session', exact: true }).click();

    // no signal worker in the emulator: the kill is queued for the machine.
    await expect(page.getByText('session ended', { exact: true })).toBeVisible();
    await expect(page.getByText('queued for the machine', { exact: true })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(MACHINE_ID) })).toHaveCount(0);

    const record = (await sessionDoc().get()).data();
    expect(record?.state).toBe('ended');
    expect(record?.endReason).toBe('killed');

    const pending = await getAdminDb().doc(`${MACHINE_PATH}/commands/pending`).get();
    const queued = Object.values(pending.data() ?? {}) as Array<{ type?: string; sid?: string }>;
    expect(queued.some((cmd) => cmd.type === 'swoop_kill' && cmd.sid === SID)).toBe(true);
  });

  test('the sidebar has a swoop section, after fleet, with live sessions and settings', async ({ page }) => {
    await gotoSwoopSessions(page);

    const sections = page.locator('#admin-sidebar').getByRole('group');
    await expect(sections).toHaveText([/^people/, /^fleet/, /^swoop/, /^hoot/, /^configuration/, /^support/]);
    await expect(sidebarSection(page, 'fleet')).toHaveText(['sites', 'installers', 'agent tokens']);
    const swoop = sidebarSection(page, 'swoop');
    await expect(swoop).toHaveText(['live sessions', 'settings']);
    await expect(swoop.nth(0)).toHaveAttribute('href', '/admin/swoop');
    await expect(swoop.nth(1)).toHaveAttribute('href', '/admin/swoop/settings');
    await expect(swoop.nth(0)).toHaveAttribute('aria-current', 'page');

    await swoop.nth(1).click();
    await expect(page).toHaveURL(/\/admin\/swoop\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'swoop settings', exact: true })).toBeVisible();
    // only the page itself is current, not live sessions, whose path it extends
    await expect(swoop.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(swoop.nth(0)).not.toHaveAttribute('aria-current');
  });

  test("swoop settings lists the site, and its row's switch writes at once", async ({ page }) => {
    await page.goto('/admin/swoop/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'swoop settings', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const swoop = page.getByRole('switch', { name: `swoop on ${SITE_NAME}`, exact: true });
    // enabled means the snapshot has answered; with no document, swoop is off. the
    // switch follows its snapshot, so the flip on screen is the document answering.
    await expect(swoop).toBeEnabled();
    await expect(swoop).not.toBeChecked();
    await swoop.click();
    await expect(swoop).toBeChecked();
    expect((await getAdminDb().doc(`sites/${SITE_ID}/settings/swoop`).get()).data()?.enabled).toBe(true);

    // a reload reads it back
    await page.reload();
    await expect(page.getByRole('switch', { name: `swoop on ${SITE_NAME}`, exact: true })).toBeChecked();
  });
});

test.describe('as a site admin of another site', () => {
  test.use(roleState('admin'));

  test('the page loads without the session on a site the admin does not hold', async ({ page }) => {
    // the record is live while the page looks, so its absence is the scoping and not the kill above.
    expect((await sessionDoc().get()).data()?.state).toBe('live');

    await gotoSwoopSessions(page);

    await expect(page.getByText(MACHINE_ID)).toHaveCount(0);
    await expect(page.getByText(viewer.email)).toHaveCount(0);
  });

  test('swoop settings never lists a site the admin does not run', async ({ page }) => {
    await page.goto('/admin/swoop/settings');
    await expect(page.getByRole('heading', { level: 1, name: 'swoop settings', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    // the site the admin does run is listed
    await expect(page.getByRole('switch', { name: 'swoop on Site A (Assigned)', exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: `swoop on ${SITE_NAME}`, exact: true })).toHaveCount(0);
  });
});
