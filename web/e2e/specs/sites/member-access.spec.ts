/**
 * sites — a person's access in the members section: the whole site or some
 * machines, set beside their site role and swoop mode in "change access..." and
 * "add member". the access column shows it from md up; a phone shows it after
 * the swoop label, and `mobile/member-access.spec.ts` measures that at 390 px.
 *
 * narrowing someone ends a swoop session they are in on a machine that left
 * their scope. as release 1 shipped it, the record says `revoked` and names
 * whom it ended for, and the audit row says `scope_changed`.
 *
 * the tests build on one another, so the file runs serially: the target is
 * narrowed and widened again, the api refuses what it cannot store, newbie is
 * added on one machine, and removing that machine leaves them with none.
 *
 * isolation: a site, two machines, a talon and four users of the spec's own,
 * all removed in afterAll. no fixture signs in, so no saved site moves.
 */

import crypto from 'crypto';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { MAX_MACHINE_SCOPE } from '@/lib/machineAccess';
import type { TalonDoc } from '@/lib/talons/types';
import { dedicatedUser, seedDedicatedUser } from '../../helpers/coverageSeed';
import { getAdminAuth, getAdminDb } from '../../helpers/emulator';
import { grantMembership, seedMachine, seedSite, setSiteSwoop, type TestUser } from '../../helpers/seed';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE = `site-access-${SUFFIX}`;
// seeded with no name, so the picker and the tooltip list them by id. neither id contains the other
const IN = `mach-access-in-${SUFFIX}`;
const OUT = `mach-access-out-${SUFFIX}`;
const GONE = `mach-access-gone-${SUFFIX}`;
const TALON = `e2e-talon-${SUFFIX}`;

// the members table's columns, in order, from md up
const COLUMNS = ['member', 'role', 'swoop', 'access', 'actions'] as const;

let owner: TestUser;
let siteAdmin: TestUser;
let target: TestUser;
let newbie: TestUser;
let restoreSwoop: () => Promise<void>;

test.beforeAll(async () => {
  // `sites: []`: dedicatedUser puts every user on site-A
  const seedPerson = (name: string) =>
    seedDedicatedUser({ ...dedicatedUser('member', `access-${name}-${SUFFIX}`), sites: [] });
  owner = await seedPerson('owner');
  siteAdmin = await seedPerson('admin');
  target = await seedPerson('target');
  newbie = await seedPerson('newbie');

  await seedSite({ id: SITE, name: `access ${SUFFIX}`, owner: owner.uid, timezone: 'UTC' });
  // no monitors, so no display subdocument outlives afterAll
  await seedMachine(SITE, IN, { monitorCount: 0 });
  await seedMachine(SITE, OUT, { monitorCount: 0 });
  restoreSwoop = await setSiteSwoop(SITE, { enabled: true });
  await grantMembership(SITE, siteAdmin.uid, 'admin');
  await grantMembership(SITE, target.uid, 'member');

  const now = new Date();
  const talon: TalonDoc = {
    schemaVersion: 1,
    name: 'e2e talon',
    enabled: true,
    trigger: { type: 'event', eventTypes: ['process_crash'] },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 15,
    createdBy: target.uid,
    createdVia: 'ui',
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
  };
  await getAdminDb().doc(`sites/${SITE}/talons/${TALON}`).set(talon);
});

test.afterAll(async () => {
  const db = getAdminDb();
  await restoreSwoop();
  for (const machineId of [IN, OUT]) {
    const machine = db.doc(`sites/${SITE}/machines/${machineId}`);
    const sessions = await machine.collection('swoop_sessions').get();
    await Promise.all(sessions.docs.map((doc) => doc.ref.delete()));
    await machine.collection('commands').doc('pending').delete();
    await machine.collection('commands').doc('completed').delete();
    await machine.delete();
  }
  await db.doc(`sites/${SITE}/talons/${TALON}`).delete();
  const people = [owner, siteAdmin, target, newbie];
  await Promise.all(people.map((user) => db.doc(`sites/${SITE}/members/${user.uid}`).delete()));
  await db.doc(`sites/${SITE}`).delete();
  // the users' own docs go too, so a lastSiteId this run wrote leaves with them
  await Promise.all(people.map((user) => db.doc(`users/${user.uid}`).delete()));
  await Promise.all(people.map((user) => getAdminAuth().deleteUser(user.uid)));
});

/** signs in through /login, as `swoop/picker.spec.ts`' fillLogin does. */
async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).first().fill(user.password);
  await page.getByRole('button', { name: /sign in with email/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

interface ApiReply {
  status: number;
  body: Record<string, unknown>;
}

/** from inside the page, so the browser's cookie jar carries the session; every call gets a fresh Idempotency-Key. */
async function apiCall(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<ApiReply> {
  return page.evaluate(
    async ([m, p, b, key]) => {
      const res = await fetch(p, {
        method: m,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { status: res.status, body: { raw: text } };
      }
    },
    [method, path, body, `member-access-${crypto.randomUUID()}`] as const,
  );
}

async function readRow(uid: string) {
  return (await getAdminDb().doc(`sites/${SITE}/members/${uid}`).get()).data() ?? null;
}

const tableRow = (page: Page, user: TestUser) =>
  page.getByRole('row').filter({ has: page.getByText(user.email, { exact: true }) });

const tableCell = (page: Page, user: TestUser, column: (typeof COLUMNS)[number]) =>
  tableRow(page, user).getByRole('cell').nth(COLUMNS.indexOf(column));

const optionsButton = (page: Page, user: TestUser) =>
  page.getByRole('button', { name: `options for ${user.email}`, exact: true });

const accessChoice = (dialog: Locator, name: 'whole site' | 'some machines') =>
  dialog.getByRole('group', { name: 'access', exact: true }).getByRole('button', { name, exact: true });

async function openMembers(page: Page): Promise<void> {
  await page.goto(`/admin/sites/${SITE}?section=members`);
  // the table has loaded once the admin's own row is in it
  await expect(tableRow(page, siteAdmin)).toBeVisible();
}

async function openChangeAccess(page: Page, user: TestUser): Promise<Locator> {
  await optionsButton(page, user).click();
  await page.getByRole('menuitem', { name: 'change access...', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'change access', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** ticks one machine in the access picker, a popover portalled outside the dialog, then closes only the popover. */
async function pickMachine(page: Page, dialog: Locator, idPrefix: 'change-access' | 'add-member', machineId: string) {
  await dialog.getByTestId(`${idPrefix}-machines-machines`).click();
  const checkbox = page.getByRole('checkbox', { name: machineId, exact: true });
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(checkbox).toBeHidden();
}

test('narrowing access ends their session on a dropped machine', async ({ page, browser }) => {
  // two sign-ins and a swoop mint come before the change itself
  test.setTimeout(90_000);
  const targetContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const targetPage = await targetContext.newPage();
    await signIn(targetPage, target);
    const granted = targetPage
      .waitForResponse(
        (r) =>
          r.url().endsWith(`/machines/${OUT}/swoop/sessions`) && r.request().method() === 'POST' && r.status() === 201,
        { timeout: 45_000 },
      )
      .then(async (r) => ((await r.json()) as { data: { sid: string; ctl: boolean } }).data);
    await targetPage.goto(`/swoop/${SITE}/${OUT}`);
    const grant = await granted;
    expect(grant.ctl).toBe(false);

    await signIn(page, siteAdmin);
    await openMembers(page);
    await expect(tableCell(page, target, 'access')).toHaveText('whole site');

    const dialog = await openChangeAccess(page, target);
    const save = dialog.getByRole('button', { name: 'save', exact: true });
    await accessChoice(dialog, 'some machines').click();
    await expect(accessChoice(dialog, 'some machines')).toHaveAttribute('aria-pressed', 'true');
    await expect(save).toBeDisabled();
    await expect(dialog.getByText('pick at least one machine', { exact: true })).toBeVisible();

    await pickMachine(page, dialog, 'change-access', IN);
    await expect(
      dialog.getByText(
        'they wrote 1 talon, which stops at its next run once their access is limited. reassign it to keep it.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(dialog.getByText(/a swoop session they are in on a machine you take away ends\.$/)).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText('access updated', { exact: true })).toBeVisible();
    await expect(page.getByText(/ access: 1 machine\.$/)).toBeVisible();
    await expect(tableCell(page, target, 'access')).toHaveText('1 machine');
    expect((await readRow(target.uid))?.machineIds).toEqual([IN]);

    // target was alone in it, and the revocation is fired after the response, so both reads poll
    await expect
      .poll(
        async () => {
          const res = await apiCall(page, 'GET', `/api/sites/${SITE}/machines/${OUT}/swoop/sessions/${grant.sid}`);
          const data = (res.body.data ?? {}) as Record<string, unknown>;
          return [res.status, data.state, data.endReason, data.endedFor];
        },
        { timeout: 10_000 },
      )
      .toEqual([200, 'ended', 'revoked', target.uid]);
    await expect
      .poll(
        async () => {
          const rows = await getAdminDb().collection(`sites/${SITE}/audit_log`).where('target.id', '==', grant.sid).get();
          return rows.docs
            .map((doc) => doc.data())
            .filter((row) => row.metadata?.event === 'session_ended')
            .map((row) => [row.metadata.endReason, row.metadata.endedFor]);
        },
        { timeout: 10_000 },
      )
      .toContainEqual(['scope_changed', target.uid]);
  } finally {
    await targetContext.close();
  }
});

test('whole site gives everything back', async ({ page }) => {
  await signIn(page, siteAdmin);
  await openMembers(page);
  const dialog = await openChangeAccess(page, target);

  // seeded from their row
  await expect(accessChoice(dialog, 'some machines')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByTestId('change-access-machines-machines')).toHaveText(IN);

  await accessChoice(dialog, 'whole site').click();
  const save = dialog.getByRole('button', { name: 'save', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText('access updated', { exact: true })).toBeVisible();
  await expect(tableCell(page, target, 'access')).toHaveText('whole site');
  expect(await readRow(target.uid)).not.toHaveProperty('machineIds');
});

test("the owner's row and your own have no change access", async ({ page }) => {
  await signIn(page, siteAdmin);
  await openMembers(page);

  // owners are never scoped, and their row offers nothing
  await expect(tableCell(page, owner, 'access')).toHaveText('whole site');
  await expect(tableCell(page, owner, 'actions')).toHaveText('—');
  await expect(optionsButton(page, owner)).toHaveCount(0);

  await optionsButton(page, siteAdmin).click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['remove...']);
});

test("the members api refuses access it cannot store, and your own or the owner's", async ({ page }) => {
  await signIn(page, siteAdmin);
  const members = `/api/sites/${SITE}/members`;
  const member = (uid: string) => `${members}/${uid}`;
  const answer = (res: ApiReply) => [res.status, res.body.code, res.body.detail];

  expect(answer(await apiCall(page, 'PATCH', member(target.uid), {}))).toEqual([
    400,
    'validation_failed',
    'role, swoop or machineIds is required',
  ]);
  expect(answer(await apiCall(page, 'PATCH', member(target.uid), { machineIds: [] }))).toEqual([
    400,
    'validation_failed',
    `machineIds must list between 1 and ${MAX_MACHINE_SCOPE} machine ids; send null for the whole site`,
  ]);
  const unknown = await apiCall(page, 'PATCH', member(target.uid), { machineIds: [GONE] });
  expect([unknown.status, unknown.body.errors]).toEqual([400, { 'body.machineIds': [`unknown machine: ${GONE}`] }]);
  const ownerAnswer = answer(await apiCall(page, 'PATCH', member(owner.uid), { machineIds: [OUT] }));
  expect(ownerAnswer.slice(0, 2)).toEqual([409, 'cannot_change_owner_role']);
  expect(ownerAnswer[2]).toMatch(/role, swoop and access come with ownership/);
  expect(answer(await apiCall(page, 'PATCH', member(siteAdmin.uid), { machineIds: [OUT] })).slice(0, 2)).toEqual([
    403,
    'cannot_modify_own_membership',
  ]);
  expect(
    answer(await apiCall(page, 'POST', members, { uid: siteAdmin.uid, role: 'admin', machineIds: [OUT] })).slice(0, 2),
  ).toEqual([403, 'cannot_modify_own_membership']);
  expect(answer(await apiCall(page, 'POST', members, { email: newbie.email, role: 'member', machineIds: [] }))).toEqual([
    400,
    'validation_failed',
    `machineIds must list between 1 and ${MAX_MACHINE_SCOPE} machine ids`,
  ]);

  // nothing was written
  expect(await readRow(target.uid)).not.toHaveProperty('machineIds');
  expect(await readRow(owner.uid)).not.toHaveProperty('machineIds');
  expect(await readRow(siteAdmin.uid)).not.toHaveProperty('machineIds');
  expect(await readRow(newbie.uid)).toBeNull();
});

test('access is set when adding', async ({ page }) => {
  await signIn(page, siteAdmin);
  await openMembers(page);
  await page
    .getByRole('region', { name: 'members', exact: true })
    .getByRole('button', { name: 'add member', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'add member', exact: true });
  await expect(dialog).toBeVisible();

  const search = dialog.getByRole('textbox', { name: 'name or email', exact: true });
  await search.fill(newbie.email);
  // the search's "no one matches" line sits over the fields below it. escape closes only that
  // layer, so it waits for the line: with none open, escape would close the dialog
  const noMatch = page.getByText(`no one from your other sites matches “${newbie.email}”.`, { exact: true });
  await expect(noMatch).toBeVisible();
  await search.press('Escape');
  await expect(noMatch).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'role', exact: true })).toHaveText('member');

  const add = dialog.getByRole('button', { name: 'add member', exact: true });
  await accessChoice(dialog, 'some machines').click();
  await expect(add).toBeDisabled();
  await expect(dialog.getByText('pick at least one machine', { exact: true })).toBeVisible();
  await pickMachine(page, dialog, 'add-member', IN);
  await expect(add).toBeEnabled();
  await add.click();

  await expect(page.getByText('member added', { exact: true })).toBeVisible();
  await expect(tableCell(page, newbie, 'access')).toHaveText('1 machine');
  expect(await readRow(newbie.uid)).toMatchObject({ role: 'member', status: 'active', machineIds: [IN] });
});

test('removing a machine leaves no one holding it', async ({ page }) => {
  await signIn(page, siteAdmin);
  await openMembers(page);
  const removed = await apiCall(page, 'DELETE', `/api/sites/${SITE}/machines/${IN}`);
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);

  await page.reload();
  await expect(tableRow(page, siteAdmin)).toBeVisible();
  // emptied by the prune, never widened
  await expect(tableCell(page, newbie, 'access')).toHaveText('no machines');
  expect((await readRow(newbie.uid))?.machineIds).toEqual([]);
});

test('a row left with no machines saves only once it reaches a machine or the whole site', async ({ page }) => {
  await signIn(page, siteAdmin);
  await openMembers(page);
  const dialog = await openChangeAccess(page, newbie);
  const save = dialog.getByRole('button', { name: 'save', exact: true });

  await expect(accessChoice(dialog, 'some machines')).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText('pick at least one machine', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();

  // a role change alone cannot carry a row with no machines
  await dialog.getByRole('combobox', { name: 'role', exact: true }).click();
  await page.getByRole('option', { name: 'admin', exact: true }).click();
  await expect(save).toBeDisabled();

  await accessChoice(dialog, 'whole site').click();
  await expect(save).toBeEnabled();
  await accessChoice(dialog, 'some machines').click();
  await expect(save).toBeDisabled();
  await pickMachine(page, dialog, 'change-access', OUT);
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toBeHidden();

  await expect(tableCell(page, newbie, 'access')).toHaveText('1 machine');
  expect(await readRow(newbie.uid)).toMatchObject({ role: 'admin', machineIds: [OUT] });
});
