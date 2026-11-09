/**
 * machine scope: a member row with `machineIds` reaches only those machines, and
 * nothing site-wide (ADR 0016). a site of the spec's own holds three machines,
 * IN, IN2 and OUT, and these people, each signed in through /login:
 * - a member limited to IN, set to no swoop;
 * - an admin limited to IN and IN2;
 * - a member whose machine scope is empty;
 * - an admin limited to IN here who administers a second site whole, which is
 *   what lets them into the admin panel to read this site's row and settings.
 *
 * they see and act on their machines only: the dashboard, its menus and dialogs,
 * the api by session and by their own key, logs and hoot. the page menu drops
 * talons, roost and deploy, the admin panel turns the first three away, and a
 * talon the scoped admin wrote switches off at its next run with nothing fired.
 *
 * the phone half is specs/mobile/machine-scope.spec.ts: the mobile-chromium
 * project matches only specs/mobile/.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { authHeaders, mintApiKey, revokeApiKey, type MintedApiKey } from '../../helpers/apiKey';
import { clearSiteLogs, dedicatedUser, seedDedicatedUser, seedLogEvents } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, seedMemberRow, seedSite, type TestUser } from '../../helpers/seed';
import type { TalonDoc } from '@/lib/talons/types';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });
// every test signs in through /login, which a cold emulator can stretch past the default
test.setTimeout(60_000);

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE = `site-scope-${SUFFIX}`;
const SITE_NAME = `scope ${SUFFIX}`;
const HOME = `site-scope-home-${SUFFIX}`;
const HOME_NAME = `home ${SUFFIX}`;
// no id contains another, so hasText filters stay strict
const IN = `mach-scope-in-${SUFFIX}`;
const IN2 = `mach-scope-two-${SUFFIX}`;
const OUT = `mach-scope-out-${SUFFIX}`;
const MACHINES = [IN, IN2, OUT];
const IN_LOG = `log-scope-in-${SUFFIX}`;
const OUT_LOG = `log-scope-out-${SUFFIX}`;
const TALON = `talon-scope-${SUFFIX}`;
const OUT_OF_SCOPE = 'machine not found or no access';

let member: TestUser;
let admin: TestUser;
let empty: TestUser;
let mixed: TestUser;
let apiKey: MintedApiKey | undefined;

test.beforeAll(async () => {
  const db = getAdminDb();
  await seedSite({ id: SITE, name: SITE_NAME, owner: 'someone-else', timezone: 'UTC' });
  await seedSite({ id: HOME, name: HOME_NAME, owner: 'someone-else', timezone: 'UTC' });
  // no monitors: a hardware subdoc would outlive the machine doc's delete
  for (const machineId of MACHINES) await seedMachine(SITE, machineId, { monitorCount: 0 });
  // swoop on, and IN able to stream, so the menus show what a swoop mode hides
  await db.doc(`sites/${SITE}/settings/swoop`).set({ enabled: true });
  await db.doc(`sites/${SITE}/machines/${IN}`).set({ capabilities: { swoop: 1 } }, { merge: true });
  await seedLogEvents(SITE, [
    { id: IN_LOG, machineId: IN },
    { id: OUT_LOG, machineId: OUT },
  ].map(({ id, machineId }) => ({
    id,
    action: 'process_started',
    level: 'info' as const,
    machineId,
    machineName: machineId,
    processName: `e2e-proc-${machineId}`,
  })));

  // `sites: []`: dedicatedUser puts everyone on site-A. the global role grants nothing.
  const person = (prefix: string) =>
    seedDedicatedUser({ ...dedicatedUser('member', `${prefix}-${SUFFIX}`), sites: [] });
  member = await person('scope-m');
  admin = await person('scope-a');
  empty = await person('scope-e');
  mixed = await person('scope-x');
  await seedMemberRow(SITE, member.uid, 'member', { machineIds: [IN], swoop: 'none' });
  await seedMemberRow(SITE, admin.uid, 'admin', { machineIds: [IN, IN2] });
  await seedMemberRow(SITE, empty.uid, 'member', { machineIds: [] });
  await seedMemberRow(SITE, mixed.uid, 'admin', { machineIds: [IN] });
  await seedMemberRow(HOME, mixed.uid, 'admin');
  // a key of their own, so hoot opens its chat rather than the no-key overlay
  await db.doc(`users/${member.uid}/settings/llm`).set({
    provider: 'openai',
    model: 'gpt-test',
    hasKey: true,
    updatedAt: FieldValue.serverTimestamp(),
  });
});

test.afterAll(async () => {
  const db = getAdminDb();
  const people = [member, admin, empty, mixed];
  if (apiKey) await revokeApiKey(apiKey);
  for (const machineId of MACHINES) {
    await db.doc(`sites/${SITE}/machines/${machineId}/commands/pending`).delete();
    await db.doc(`sites/${SITE}/machines/${machineId}`).delete();
  }
  // the seeded rows, and the two the talon's run wrote
  await clearSiteLogs(SITE);
  await db.doc(`sites/${SITE}/talons/${TALON}`).delete();
  const runs = await db.collection(`sites/${SITE}/talon_runs`).listDocuments();
  await Promise.all(runs.map((ref) => ref.delete()));
  await db.doc(`sites/${SITE}/settings/swoop`).delete();
  for (const uid of ['someone-else', ...people.map((p) => p.uid)]) {
    await db.doc(`sites/${SITE}/members/${uid}`).delete();
  }
  for (const uid of ['someone-else', mixed.uid]) await db.doc(`sites/${HOME}/members/${uid}`).delete();
  await db.doc(`sites/${SITE}`).delete();
  await db.doc(`sites/${HOME}`).delete();
  await db.doc(`users/${member.uid}/settings/llm`).delete();
  for (const p of people) {
    await db.doc(`users/${p.uid}`).delete();
    await getAdminAuth().deleteUser(p.uid);
  }
});

async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

const card = (page: Page, machineId: string) =>
  page.getByTestId('machine-card').filter({ hasText: machineId });

/** a card's menu. it portals out of the card, so it is reached by role. */
async function openMenu(page: Page, machineId: string): Promise<Locator> {
  await card(page, machineId).getByTestId('machine-context-menu-trigger').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * a same-origin fetch inside the page, which carries the session cookie that
 * playwright's own request context drops on http loopback.
 */
async function callApi(page: Page, method: 'GET' | 'POST', path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body, idempotencyKey }) => {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers:
          body === undefined
            ? undefined
            : { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    { method, path, body, idempotencyKey: crypto.randomUUID() },
  );
}

async function pendingCommands(machineId: string): Promise<Record<string, { type?: string }>> {
  const snap = await getAdminDb().doc(`sites/${SITE}/machines/${machineId}/commands/pending`).get();
  return (snap.data() ?? {}) as Record<string, { type?: string }>;
}

async function pendingTypes(machineId: string): Promise<Array<string | undefined>> {
  return Object.values(await pendingCommands(machineId)).map((command) => command.type);
}

test('a scoped member sees only their machine, and only the pages that fit it', async ({ page }) => {
  await signIn(page, member);
  await expect(card(page, IN)).toBeVisible();
  await expect(page.getByTestId('machine-card')).toHaveCount(1);
  await expect(card(page, IN2)).toHaveCount(0);
  await expect(card(page, OUT)).toHaveCount(0);
  await expect(page.getByText("machines couldn't load")).toHaveCount(0);

  // set to no swoop: the menu offers live view in its place
  const menu = await openMenu(page, IN);
  await expect(menu.getByTestId('machine-context-menu-live-view')).toBeVisible();
  await expect(menu.getByTestId('machine-context-menu-swoop')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await page.getByTestId('view-toggle-list').click();
  await expect(page.getByTestId('machine-row').filter({ hasText: IN })).toBeVisible();
  await expect(page.getByTestId('machine-row')).toHaveCount(1);

  // the page switcher: an item holds its name and its description, so match from the name
  await page.getByRole('button', { name: /^dashboard$/i }).click();
  const pages = page.getByRole('menu');
  for (const name of ['dashboard', 'hoot', 'logs']) {
    await expect(pages.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  for (const name of ['talons', 'roost', 'deploy']) {
    await expect(pages.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toHaveCount(0);
  }
  await page.keyboard.press('Escape');

  await page.getByTestId('user-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'sign out' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /admin panel/i })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`/admin/sites/${SITE}`);
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });

  await page.goto('/deployments');
  await expect(page.getByText('this page needs whole-site access', { exact: true })).toBeVisible();
});

test('an empty machine scope says so, and offers no pairing', async ({ page }) => {
  await signIn(page, empty);
  await expect(page.getByText('no machines here for you yet', { exact: true })).toBeVisible();
  await expect(
    page.getByText('a site admin chooses which machines you can reach.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('getting-started-enter-phrase')).toHaveCount(0);
  await expect(page.getByTestId('getting-started-authorize')).toHaveCount(0);
  await expect(page.getByTestId('machine-card')).toHaveCount(0);
  await expect(page.getByText("machines couldn't load")).toHaveCount(0);
});

test("a scoped admin's menus act on their machines, and on nothing site-wide", async ({ page }) => {
  await signIn(page, admin);
  await expect(card(page, IN)).toBeVisible();
  await expect(card(page, IN2)).toBeVisible();
  await expect(card(page, OUT)).toHaveCount(0);

  const menu = await openMenu(page, IN);
  await expect(menu.getByTestId('machine-context-menu-reboot')).toBeVisible();
  await expect(menu.getByTestId('machine-context-menu-shutdown')).toBeVisible();
  // no swoop mode of their own, so the admin role's control holds
  await expect(menu.getByTestId('machine-context-menu-swoop')).toBeVisible();
  // revoking the token and removing the machine are site-wide
  await expect(menu.getByTestId('machine-context-menu-revoke-token')).toHaveCount(0);
  await expect(menu.getByTestId('machine-context-menu-remove')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await expect(card(page, IN).getByRole('button', { name: /^add process$/i })).toBeVisible();

  await page.getByTestId('site-switcher-trigger').click();
  // the site's own item renders with the entries below it, so it is the sign they are in
  await expect(page.getByRole('menuitem', { name: SITE_NAME })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'site settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'manage sites', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // /admin has no page of its own: the sites page is where the admin panel opens
  for (const route of ['/admin/sites', `/admin/sites/${SITE}`]) {
    await page.goto(route);
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
  }
});

test("a scoped admin's schedule dialogs offer only their machines", async ({ page }) => {
  await signIn(page, admin);
  const menu = await openMenu(page, IN);
  // online, so schedule restarts is the gear half of the restart row
  await menu.getByTestId('machine-context-menu-schedule-restarts-gear').click();
  const schedule = page.getByRole('dialog', { name: /^restart schedule — / });
  await expect(schedule).toBeVisible();

  await schedule.getByRole('button', { name: 'apply to other machines...' }).click();
  const apply = page.getByRole('dialog', { name: 'apply restart schedule to...' });
  await expect(apply.getByText(IN2, { exact: true })).toBeVisible();
  // IN is the current machine, which leaves IN2 the only other one
  await expect(apply.getByText('0 of 1 selected', { exact: true })).toBeVisible();
  await expect(apply.getByText(OUT)).toHaveCount(0);
});

test("a scoped admin's commands reach their machines only, by session", async ({ page }) => {
  await signIn(page, admin);
  const screenshot = { type: 'capture_screenshot' };

  const refused = await callApi(page, 'POST', `/api/sites/${SITE}/machines/${OUT}/commands`, screenshot);
  expect(refused.status).toBe(404);
  expect(refused.body.detail).toBe(OUT_OF_SCOPE);
  expect(await pendingTypes(OUT)).not.toContain('capture_screenshot');

  const queued = await callApi(page, 'POST', `/api/sites/${SITE}/machines/${IN}/commands`, screenshot);
  expect(queued.status).toBe(202);
  expect((await pendingCommands(IN))[queued.body.data.commandId]?.type).toBe('capture_screenshot');

  const listed = await callApi(page, 'GET', `/api/sites/${SITE}/machines`);
  expect(listed.status).toBe(200);
  expect(listed.body.machines.map((machine: { id: string }) => machine.id)).toEqual([IN, IN2]);
});

test("a scoped admin's own api key reaches their machines only", async ({ request }) => {
  apiKey = await mintApiKey({
    ownerUid: admin.uid,
    name: `e2e-scope-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['write'] }],
  });
  const commands = (machineId: string) => `/api/sites/${SITE}/machines/${machineId}/commands`;
  const data = { type: 'capture_screenshot' };

  const refused = await request.post(commands(OUT), { headers: authHeaders(apiKey), data });
  expect(refused.status()).toBe(404);
  expect((await refused.json()).detail).toBe(OUT_OF_SCOPE);
  expect(await pendingTypes(OUT)).not.toContain('capture_screenshot');

  const queued = await request.post(commands(IN), { headers: authHeaders(apiKey), data });
  expect(queued.status()).toBe(202);
  const { commandId } = (await queued.json()).data;
  expect((await pendingCommands(IN))[commandId]?.type).toBe('capture_screenshot');
});

test("a scoped member's logs hold only their machine's rows", async ({ page }) => {
  await signIn(page, member);
  await page.goto('/logs');
  await expect(page.getByRole('heading', { name: /^logs$/i })).toBeVisible();
  const inRow = page.getByTestId(`log-row-${IN_LOG}`);
  await expect(inRow).toBeVisible();
  await expect(inRow).toContainText(`e2e-proc-${IN}`);
  await expect(page.getByTestId(`log-row-${OUT_LOG}`)).toHaveCount(0);
  await expect(page.getByText(`e2e-proc-${OUT}`)).toHaveCount(0);
});

test("a scoped member's hoot picker lists only their machine", async ({ page }) => {
  await signIn(page, member);
  await page.goto('/hoot');
  await page.getByLabel(/hoot target/i).click();
  // a row's name is the machine id, matched from its start
  const row = (machineId: string) => page.getByRole('menuitemcheckbox', { name: new RegExp(`^${machineId}`) });
  await expect(row(IN)).toBeVisible();
  await expect(row(IN2)).toHaveCount(0);
  await expect(row(OUT)).toHaveCount(0);
});

test('an admin elsewhere reads their limited site in the sites list, without its settings', async ({ page }) => {
  await signIn(page, mixed);
  await page.goto('/admin/sites');
  const sites = page.getByRole('list', { name: 'sites', exact: true });
  const limited = sites.getByRole('listitem').filter({ hasText: SITE_NAME });
  await expect(limited).toContainText('admin · 1 machine');
  await expect(limited.getByRole('link', { name: `settings for ${SITE_NAME}` })).toHaveCount(0);
  // the site they administer whole keeps its gear
  await expect(sites.getByRole('link', { name: `settings for ${HOME_NAME}` })).toBeVisible();

  await page.goto(`/admin/sites/${SITE}`);
  await expect(page.getByRole('heading', { level: 1, name: SITE_NAME, exact: true })).toBeVisible();
  await expect(
    page.getByText(
      `your access to ${SITE_NAME} is limited to some machines, and its settings need the whole site. ask its owner or an admin.`,
      { exact: true },
    ),
  ).toBeVisible();
});

test.describe('a talon the scoped admin wrote', () => {
  test.use(roleState('superadmin'));

  test('switches off at its next run, with nothing fired', async ({ page }) => {
    const now = Timestamp.now();
    const talon: TalonDoc = {
      schemaVersion: 1,
      name: `scope talon ${SUFFIX}`,
      enabled: true,
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      condition: { type: 'none' },
      // a command output: before every talon re-checked its author, only hoot
      // outputs and visual checks did, and this one would have fired
      outputs: [{ type: 'command', commandType: 'restart_process', processName: `e2e-proc-${IN}` }],
      scope: { machineIds: [IN] },
      cooldownMinutes: 15,
      createdBy: admin.uid,
      createdVia: 'ui',
      createdAt: now,
      updatedAt: now,
      consecutiveFailures: 0,
    };
    await getAdminDb().doc(`sites/${SITE}/talons/${TALON}`).set(talon);

    // the re-run button on /talons, which a superadmin may press on any site
    await page.goto('/dashboard');
    await expect(page.getByTestId('user-menu-trigger')).toBeVisible();
    const run = await callApi(page, 'POST', `/api/sites/${SITE}/talons/${TALON}/test`);
    expect(run.status).toBe(200);
    expect(run.body.runs).toEqual([
      expect.objectContaining({ status: 'failed', disabledReason: 'creator_access_revoked' }),
    ]);

    const stored = (await getAdminDb().doc(`sites/${SITE}/talons/${TALON}`).get()).data();
    expect(stored).toMatchObject({ enabled: false, disabledReason: 'creator_access_revoked' });
    expect(await pendingTypes(IN)).not.toContain('restart_process');
  });
});
