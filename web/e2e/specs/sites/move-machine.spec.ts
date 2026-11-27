/**
 * sites: moving a machine to another site, from the machines section of a
 * site's settings (`/admin/sites/{siteId}?section=machines`).
 *
 * a superadmin asks for a move (the row's `moving to` tag, the stored move and
 * its `site_move` command) and cancels it; the row leaves the list on its own
 * once the machine has arrived, and an offline machine's row says it is
 * waiting to move; an agent too old to follow, a
 * machine of the same id on the target and a busy machine are refused with
 * their copy. the agent's half is driven at its routes: the credential fetch
 * calls google's real endpoint, so the move is seeded `switching`, and the
 * confirm is posted with an emulator agent token for the target. a target that
 * refuses before the mint (a machine of the same id) ends the move at once, and
 * the target can't be deleted while a machine is switching into it. an admin of
 * both sites moves a machine; someone who administers only the source gets no
 * move button but can cancel a move already asked for, and a scoped admin of
 * the target is not offered it and is refused by the route. at 390px a row's
 * three buttons stay inside the viewport, the whole name shows on the first
 * line, and the status takes the line under it, as the sites list's details do,
 * followed by the tag: `moving`, with the site in its title.
 *
 * the sites and machines are the spec's own; afterAll deletes every document
 * the spec or the routes wrote, and takes back the fixtures' grants.
 */

import crypto from 'crypto';
import { test, expect, type Page } from '@playwright/test';
import { Timestamp } from 'firebase-admin/firestore';
import { MOVE_BUSY, MOVE_EXISTS, MOVE_TOO_OLD, SITE_DELETE_MOVING } from '@/lib/machineMove';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';
import { agentIdToken } from '../../helpers/agentToken';
import { getAdminDb } from '../../helpers/emulator';
import { assertNoHorizontalOverflow, expectFullyWithinViewport } from '../../helpers/mobile';
import { roleState } from '../../helpers/roles';
import {
  grantMembership,
  releaseFixtureSite,
  revokeMembership,
  seedMachine,
  seedSite,
  TEST_USERS,
} from '../../helpers/seed';

// both sort after site-A by name, so neither becomes a fixture's current site
const SOURCE = { id: 'site-move-source', name: 'Site Move Source' };
const TARGET = { id: 'site-move-target', name: 'Site Move Target' };
const LONG_TARGET = {
  id: 'site-move-long-target',
  name: 'Site Move Target With A Name Long Enough To Crowd A Phone Row',
};

// no id holds another, so a row found by its id is one row
const READY = 'e2e-move-ready';
const OLD = 'e2e-move-old';
const CLASH = 'e2e-move-clash';
const BUSY = 'e2e-move-busy';
const CONFIRM = 'e2e-move-confirm';
const BOTH = 'e2e-move-both';
const PHONE = 'e2e-move-phone';
const REFUSED = 'e2e-move-refused';
const ARRIVING = 'e2e-move-arriving';
const OFFLINE = 'e2e-move-offline';
// a move doc only: the machine needs no row for the target's delete to be refused
const SWITCHING = 'e2e-move-switching';
const SOURCE_MACHINES = [READY, OLD, CLASH, BUSY, CONFIRM, BOTH, PHONE, REFUSED, ARRIVING, OFFLINE, SWITCHING];

const SOURCE_TOKEN = 'e2e-move-confirm-source-token';
const TARGET_TOKEN = 'e2e-move-confirm-target-token';
const REFUSED_TOKEN = 'e2e-move-refused-source-token';
// the mint route looks a refresh token up by its hash, as refresh does
const REFUSED_TOKEN_PATH = `agent_refresh_tokens/${crypto.createHash('sha256').update(REFUSED_TOKEN).digest('hex')}`;
const DAY_MS = 24 * 60 * 60 * 1000;

const { admin, member, superadmin } = TEST_USERS;

test.use(roleState('superadmin'));

const machinePath = (siteId: string, machineId: string) => `sites/${siteId}/machines/${machineId}`;
const pendingPath = (siteId: string, machineId: string) => `${machinePath(siteId, machineId)}/commands/pending`;
const movePath = (machineId: string) => `machine_moves/${SOURCE.id}:${machineId}`;

async function readDoc(path: string) {
  return (await getAdminDb().doc(path).get()).data() ?? null;
}

/** a pending move as the request route stores it: times in epoch ms, the requester by uid. */
async function seedMove(machineId: string, targetSiteId: string, status: 'pending' | 'switching', requestedBy: string) {
  const requestedAt = Date.now();
  await getAdminDb()
    .doc(movePath(machineId))
    .set({
      moveId: `${SOURCE.id}:${machineId}`,
      sourceSiteId: SOURCE.id,
      targetSiteId,
      machineId,
      status,
      requestedBy,
      requestedAt,
      expiresAt: requestedAt + 7 * DAY_MS,
    });
}

/** the `site_move` entries in the source machine's pending map. */
async function siteMoveCommands(machineId: string) {
  const pending = (await readDoc(pendingPath(SOURCE.id, machineId))) ?? {};
  return (Object.values(pending) as Array<{ type?: string; moveId?: string; status?: string }>).filter(
    (command) => command.type === 'site_move',
  );
}

const machinesPanel = (page: Page) => page.getByRole('region', { name: 'machines', exact: true });

async function openMachines(page: Page, siteId = SOURCE.id) {
  await page.goto(`/admin/sites/${siteId}?section=machines`);
  await expect(machinesPanel(page)).toBeVisible();
}

// in the panel: a toast is a listitem too, and the move's names the machine
const row = (page: Page, machineId: string) =>
  machinesPanel(page).getByRole('listitem').filter({ hasText: machineId });

/** the move dialog for a machine, from its row's move button. */
async function openMoveDialog(page: Page, machineId: string) {
  await row(page, machineId).getByRole('button', { name: `move ${machineId}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `move ${machineId}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** pick a site in the dialog's `move to` select and press `move machine`. */
async function moveTo(page: Page, machineId: string, siteName: string) {
  const dialog = await openMoveDialog(page, machineId);
  await dialog.getByRole('combobox', { name: 'move to', exact: true }).click();
  // the select's list is portalled, so outside the dialog
  await page.getByRole('option', { name: siteName, exact: true }).click();
  await dialog.getByRole('button', { name: 'move machine', exact: true }).click();
  return dialog;
}

/** the move route, from the page so the session cookie goes with it (see access-control/machine-card). */
async function postMove(page: Page, machineId: string, targetSiteId: string) {
  return page.evaluate(
    async ({ siteId, machineId: id, targetSiteId: target }) => {
      const res = await fetch(`/api/sites/${siteId}/machines/${id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `e2e-move-${id}-${Date.now()}` },
        body: JSON.stringify({ targetSiteId: target }),
      });
      return { status: res.status, body: (await res.json()) as { code?: string; detail?: string } };
    },
    { siteId: SOURCE.id, machineId, targetSiteId },
  );
}

test.beforeAll(async () => {
  await Promise.all([SOURCE, TARGET, LONG_TARGET].map((site) => seedSite({ ...site, owner: 'someone-else' })));
  // the superadmin moves a machine only between sites they are a member of (adr 0021)
  for (const site of [SOURCE, TARGET, LONG_TARGET]) await grantMembership(site.id, superadmin.uid, 'admin');
  // no monitors, so no display subdocument outlives afterAll
  await Promise.all([
    ...[READY, CLASH, BUSY, BOTH, PHONE, REFUSED, ARRIVING, OFFLINE].map((id) =>
      seedMachine(SOURCE.id, id, { siteMove: true, monitorCount: 0 }),
    ),
    seedMachine(SOURCE.id, OLD, { monitorCount: 0 }),
    seedMachine(TARGET.id, CLASH, { monitorCount: 0 }),
    seedMachine(TARGET.id, REFUSED, { monitorCount: 0 }),
  ]);
  // an install the agent has not finished keeps the machine where it is
  await getAdminDb()
    .doc(pendingPath(SOURCE.id, BUSY))
    .set({ cmd_e2e_install: { type: 'install_software', status: 'pending', timestamp: Timestamp.now() } });
  await seedMove(PHONE, LONG_TARGET.id, 'pending', superadmin.uid);
});

test.afterAll(async () => {
  const db = getAdminDb();
  const paths = [
    ...SOURCE_MACHINES.flatMap((id) => [machinePath(SOURCE.id, id), pendingPath(SOURCE.id, id), movePath(id)]),
    machinePath(TARGET.id, CLASH),
    machinePath(TARGET.id, CONFIRM),
    machinePath(TARGET.id, REFUSED),
    `config/${SOURCE.id}/machines/${CONFIRM}`,
    `agent_refresh_tokens/${SOURCE_TOKEN}`,
    `agent_refresh_tokens/${TARGET_TOKEN}`,
    REFUSED_TOKEN_PATH,
  ];
  await Promise.all(paths.map((path) => db.doc(path).delete()));
  for (const uid of [admin.uid, member.uid, superadmin.uid]) {
    await revokeMembership(SOURCE.id, uid);
    await revokeMembership(TARGET.id, uid);
  }
  await revokeMembership(LONG_TARGET.id, superadmin.uid);
  await Promise.all([SOURCE, TARGET, LONG_TARGET].map((site) => releaseFixtureSite(site.id, 'someone-else')));
});

test('a superadmin moves a machine, and cancels the move', async ({ page }) => {
  await openMachines(page);
  const dialog = await moveTo(page, READY, TARGET.name);

  await expect(page.getByText('move requested', { exact: true })).toBeVisible();
  await expect(page.getByText(`${READY} moves to ${TARGET.name} within seconds.`)).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(row(page, READY).getByText(`moving to ${TARGET.name}`, { exact: true })).toBeVisible();

  const move = await readDoc(movePath(READY));
  expect(move).toMatchObject({
    moveId: `${SOURCE.id}:${READY}`,
    sourceSiteId: SOURCE.id,
    targetSiteId: TARGET.id,
    machineId: READY,
    status: 'pending',
    requestedBy: superadmin.uid,
  });
  expect(move!.expiresAt - move!.requestedAt).toBe(7 * DAY_MS);
  expect(await siteMoveCommands(READY)).toEqual([
    expect.objectContaining({ moveId: `${SOURCE.id}:${READY}`, status: 'pending' }),
  ]);

  // while pending, the move button is the cancel
  await row(page, READY).getByRole('button', { name: `cancel move of ${READY}`, exact: true }).click();
  await expect(page.getByText('move cancelled', { exact: true })).toBeVisible();
  await expect(row(page, READY).getByText(`moving to ${TARGET.name}`, { exact: true })).toHaveCount(0);
  await expect(row(page, READY).getByRole('button', { name: `move ${READY}`, exact: true })).toBeVisible();

  expect(await readDoc(movePath(READY))).toBeNull();
  expect(await siteMoveCommands(READY)).toEqual([]);
});

test('the row leaves the list on its own once the machine has arrived on the target', async ({ page }) => {
  await seedMove(ARRIVING, TARGET.id, 'pending', superadmin.uid);
  await openMachines(page);
  await expect(row(page, ARRIVING).getByText(`moving to ${TARGET.name}`, { exact: true })).toBeVisible();

  // what the agent's confirm leaves on the source: no move, and no machine
  const db = getAdminDb();
  await db.doc(movePath(ARRIVING)).delete();
  await db.doc(machinePath(SOURCE.id, ARRIVING)).delete();

  // no reload: the list asks again while a move is open
  await expect(row(page, ARRIVING)).toHaveCount(0, { timeout: 15_000 });
});

test("an offline machine's move waits, and its row says it is waiting", async ({ page }) => {
  await getAdminDb().doc(machinePath(SOURCE.id, OFFLINE)).update({ online: false });
  await seedMove(OFFLINE, TARGET.id, 'pending', superadmin.uid);

  await openMachines(page);

  await expect(row(page, OFFLINE).getByText(`waiting to move to ${TARGET.name}`, { exact: true })).toBeVisible();
  await expect(row(page, OFFLINE).getByText(`moving to ${TARGET.name}`, { exact: true })).toHaveCount(0);
});

test('an agent too old to follow: the dialog says so and cannot move it, and the route agrees', async ({ page }) => {
  await openMachines(page);
  const dialog = await openMoveDialog(page, OLD);

  await expect(dialog.getByText(MOVE_TOO_OLD(OLD, '2.9.0', SITE_MOVE_MIN_AGENT_VERSION))).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'move to', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'move machine', exact: true })).toBeDisabled();

  const refused = await postMove(page, OLD, TARGET.id);
  expect(refused.status).toBe(409);
  expect(refused.body).toMatchObject({
    code: 'agent_too_old',
    detail: MOVE_TOO_OLD(OLD, '2.9.0', SITE_MOVE_MIN_AGENT_VERSION),
  });
  expect(await readDoc(movePath(OLD))).toBeNull();
});

test('a machine of the same id on the target is refused with its copy', async ({ page }) => {
  await openMachines(page);
  const dialog = await moveTo(page, CLASH, TARGET.name);

  await expect(page.getByText('could not move the machine', { exact: true })).toBeVisible();
  await expect(page.getByText(MOVE_EXISTS(TARGET.name, CLASH))).toBeVisible();
  // a refusal leaves the dialog up, to pick another site or cancel
  await expect(dialog).toBeVisible();
  expect(await readDoc(movePath(CLASH))).toBeNull();
  expect(await siteMoveCommands(CLASH)).toEqual([]);
});

test('a machine mid-install is refused with its copy', async ({ page }) => {
  await openMachines(page);
  await moveTo(page, BUSY, TARGET.name);

  await expect(page.getByText('could not move the machine', { exact: true })).toBeVisible();
  await expect(page.getByText(MOVE_BUSY(BUSY))).toBeVisible();
  expect(await readDoc(movePath(BUSY))).toBeNull();
  expect(await siteMoveCommands(BUSY)).toEqual([]);
});

test('a move the target refuses when the agent comes for its tokens ends at once', async ({ page, request }) => {
  const db = getAdminDb();
  // asked for before the target gained a machine of this id
  await seedMove(REFUSED, TARGET.id, 'pending', superadmin.uid);
  await db
    .doc(pendingPath(SOURCE.id, REFUSED))
    .set({ cmd_e2e_site_move: { type: 'site_move', moveId: `${SOURCE.id}:${REFUSED}`, status: 'pending' } });
  await db.doc(REFUSED_TOKEN_PATH).set({
    siteId: SOURCE.id,
    machineId: REFUSED,
    version: SITE_MOVE_MIN_AGENT_VERSION,
    createdBy: 'e2e',
    createdAt: Timestamp.now(),
    lastUsed: Timestamp.now(),
    expiresAt: null,
    agentUid: `agent_${SOURCE.id}_${REFUSED}`,
  });

  await openMachines(page);
  await expect(row(page, REFUSED).getByText(`moving to ${TARGET.name}`, { exact: true })).toBeVisible();

  // refused before any mint, so it runs on the emulators
  const refused = await request.post('/api/agent/auth/move', {
    data: { refreshToken: REFUSED_TOKEN, machineId: REFUSED, moveId: `${SOURCE.id}:${REFUSED}` },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({ error: MOVE_EXISTS(TARGET.name, REFUSED) });
  expect(await readDoc(movePath(REFUSED))).toBeNull();
  expect(await siteMoveCommands(REFUSED)).toEqual([]);

  await openMachines(page);
  await expect(row(page, REFUSED).getByRole('button', { name: `move ${REFUSED}`, exact: true })).toBeVisible();
  await expect(row(page, REFUSED).getByText(`moving to ${TARGET.name}`, { exact: true })).toHaveCount(0);
  const again = await postMove(page, REFUSED, TARGET.id);
  expect(again.status).toBe(409);
  expect(again.body).toMatchObject({ code: 'machine_exists', detail: MOVE_EXISTS(TARGET.name, REFUSED) });
});

test('the target site cannot be deleted while a machine is switching into it', async ({ page }) => {
  await seedMove(SWITCHING, TARGET.id, 'switching', superadmin.uid);

  await page.goto(`/admin/sites/${TARGET.id}?section=danger`);
  await expect(page.getByRole('heading', { level: 1, name: TARGET.name, exact: true })).toBeVisible();
  await page.getByRole('region', { name: 'danger zone' }).getByRole('button', { name: 'delete site', exact: true }).click();
  const confirmDialog = page.getByRole('dialog', { name: /^delete site$/ });
  await confirmDialog.getByRole('button', { name: 'delete site', exact: true }).click();

  await expect(page.getByText('could not delete the site', { exact: true })).toBeVisible();
  await expect(page.getByText(SITE_DELETE_MOVING('into'))).toBeVisible();
  await expect(confirmDialog).toBeVisible();
  expect(await readDoc(`sites/${TARGET.id}`)).not.toBeNull();
  expect(await readDoc(movePath(SWITCHING))).toMatchObject({ status: 'switching' });

  await getAdminDb().doc(movePath(SWITCHING)).delete();
});

test('the agent confirms from the target: the source copy is gone and the target has the machine', async ({
  page,
  request,
}) => {
  const db = getAdminDb();
  // the state after the credential fetch: the move switching, the agent already heartbeating on the target
  await seedMachine(SOURCE.id, CONFIRM, { siteMove: true, monitorCount: 0 });
  await db.doc(`config/${SOURCE.id}/machines/${CONFIRM}`).set({ processes: [] });
  await db
    .doc(pendingPath(SOURCE.id, CONFIRM))
    .set({ cmd_e2e_site_move: { type: 'site_move', moveId: `${SOURCE.id}:${CONFIRM}`, status: 'pending' } });
  await seedMove(CONFIRM, TARGET.id, 'switching', superadmin.uid);
  await seedMachine(TARGET.id, CONFIRM, { siteMove: true, monitorCount: 0 });
  const tokenDoc = (siteId: string) => ({
    siteId,
    machineId: CONFIRM,
    version: '4.2.3',
    createdBy: 'e2e',
    createdAt: Timestamp.now(),
    lastUsed: Timestamp.now(),
    expiresAt: null,
    agentUid: `agent_${siteId}_${CONFIRM}`,
  });
  await db.doc(`agent_refresh_tokens/${SOURCE_TOKEN}`).set(tokenDoc(SOURCE.id));
  await db.doc(`agent_refresh_tokens/${TARGET_TOKEN}`).set(tokenDoc(TARGET.id));

  // switching: the row keeps its tag, and nothing on the page can stop it
  await openMachines(page);
  await expect(row(page, CONFIRM).getByText(`moving to ${TARGET.name}`, { exact: true })).toBeVisible();
  await expect(row(page, CONFIRM).getByRole('button', { name: `cancel move of ${CONFIRM}`, exact: true })).toBeDisabled();

  const confirm = (idToken: string) =>
    request.post('/api/agent/auth/move/confirm', {
      headers: { Authorization: `Bearer ${idToken}` },
      data: { machineId: CONFIRM, moveId: `${SOURCE.id}:${CONFIRM}` },
    });

  // the source's token still verifies, but only the target may confirm the arrival
  const fromSource = await confirm(await agentIdToken(SOURCE.id, CONFIRM));
  expect(fromSource.status()).toBe(403);
  expect(await fromSource.json()).toMatchObject({ code: 'wrong_site' });
  expect(await readDoc(machinePath(SOURCE.id, CONFIRM))).not.toBeNull();
  expect(await readDoc(movePath(CONFIRM))).toMatchObject({ status: 'switching' });

  const fromTarget = await confirm(await agentIdToken(TARGET.id, CONFIRM));
  expect(fromTarget.status()).toBe(200);
  expect(await fromTarget.json()).toEqual({
    moveId: `${SOURCE.id}:${CONFIRM}`,
    sourceSiteId: SOURCE.id,
    targetSiteId: TARGET.id,
    machineId: CONFIRM,
  });

  expect(await readDoc(machinePath(SOURCE.id, CONFIRM))).toBeNull();
  expect(await readDoc(`config/${SOURCE.id}/machines/${CONFIRM}`)).toBeNull();
  expect(await readDoc(pendingPath(SOURCE.id, CONFIRM))).toBeNull();
  expect(await readDoc(`agent_refresh_tokens/${SOURCE_TOKEN}`)).toBeNull();
  expect(await readDoc(movePath(CONFIRM))).toBeNull();
  expect(await readDoc(`agent_refresh_tokens/${TARGET_TOKEN}`)).not.toBeNull();
  expect((await readDoc(machinePath(TARGET.id, CONFIRM)))?.pairedAt).toBeTruthy();

  // a second confirm finds no move, which the agent reads as done
  const again = await confirm(await agentIdToken(TARGET.id, CONFIRM));
  expect(again.status()).toBe(404);

  await openMachines(page);
  await expect(row(page, READY)).toBeVisible();
  await expect(row(page, CONFIRM)).toHaveCount(0);
  await openMachines(page, TARGET.id);
  await expect(row(page, CONFIRM)).toBeVisible();
});

test.describe('an admin of both sites', () => {
  test.use(roleState('admin'));

  test.beforeAll(async () => {
    await grantMembership(SOURCE.id, admin.uid, 'admin');
    await grantMembership(TARGET.id, admin.uid, 'admin');
  });

  test('is offered the sites they administer, and moves a machine', async ({ page }) => {
    await openMachines(page);
    const dialog = await openMoveDialog(page, BOTH);
    await dialog.getByRole('combobox', { name: 'move to', exact: true }).click();
    // site-A is theirs from the baseline; site-B and the long-named site are not
    await expect(page.getByRole('option', { name: 'Site A (Assigned)', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Site B (Unassigned)', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: LONG_TARGET.name, exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: TARGET.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'move machine', exact: true }).click();

    await expect(page.getByText('move requested', { exact: true })).toBeVisible();
    await expect(row(page, BOTH).getByText(`moving to ${TARGET.name}`, { exact: true })).toBeVisible();
    expect(await readDoc(movePath(BOTH))).toMatchObject({
      targetSiteId: TARGET.id,
      status: 'pending',
      requestedBy: admin.uid,
    });
  });
});

test.describe('an admin of the source alone', () => {
  test.use(roleState('member'));

  test.beforeAll(async () => {
    await grantMembership(SOURCE.id, member.uid, 'admin');
  });

  test('gets no move button, but can cancel a move already asked for', async ({ page }) => {
    await openMachines(page);
    await expect(row(page, READY).getByRole('button', { name: `restart ${READY}`, exact: true })).toBeVisible();
    await expect(row(page, READY).getByRole('button', { name: `remove ${READY}`, exact: true })).toBeVisible();
    await expect(row(page, READY).getByRole('button', { name: `move ${READY}`, exact: true })).toHaveCount(0);
    await expect(row(page, PHONE).getByRole('button', { name: `cancel move of ${PHONE}`, exact: true })).toBeEnabled();
  });

  test('a scoped admin of the target is not offered it, and the route refuses the move', async ({ page }) => {
    await grantMembership(TARGET.id, member.uid, 'admin', { machineIds: [CLASH] });

    await openMachines(page);
    await expect(row(page, READY).getByRole('button', { name: `restart ${READY}`, exact: true })).toBeVisible();
    await expect(row(page, READY).getByRole('button', { name: `move ${READY}`, exact: true })).toHaveCount(0);

    const refused = await postMove(page, READY, TARGET.id);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toBe('you may not add machines to the target site.');
    expect(await readDoc(movePath(READY))).toBeNull();
    expect(await siteMoveCommands(READY)).toEqual([]);
  });
});

test.describe('at 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a row's three buttons stay inside the viewport, with and without a move", async ({ page }) => {
    await openMachines(page);
    // a phone line has room for one word after the status: the site moves into the tag's title
    const tag = row(page, PHONE).getByTitle(`moving to ${LONG_TARGET.name}`, { exact: true });
    await expect(tag).toBeVisible();
    await expect(tag).toHaveText('moving');

    const buttons: Array<[string, string]> = [
      [PHONE, `restart ${PHONE}`],
      [PHONE, `cancel move of ${PHONE}`],
      [PHONE, `remove ${PHONE}`],
      [READY, `restart ${READY}`],
      [READY, `move ${READY}`],
      [READY, `remove ${READY}`],
    ];
    for (const [machineId, name] of buttons) {
      await expectFullyWithinViewport(page, row(page, machineId).getByRole('button', { name, exact: true }), name);
    }
    await assertNoHorizontalOverflow(page);

    // the document check can't see overflow inside the row: measure the tag against its neighbours.
    // as on the sites list, the name and the buttons share the first line and the status takes the second
    const name = row(page, PHONE).getByTitle(PHONE, { exact: true });
    const nameBox = await name.boundingBox();
    const tagBox = await tag.boundingBox();
    // the status line reads 'online · moving'
    const statusBox = await row(page, PHONE).getByText(/^online/).boundingBox();
    const restartBox = await row(page, PHONE).getByRole('button', { name: `restart ${PHONE}`, exact: true }).boundingBox();
    // the whole name shows, not an ellipsis
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(tagBox && restartBox && tagBox.x + tagBox.width).toBeLessThanOrEqual((restartBox?.x ?? 0) + 1);
    expect(nameBox && statusBox && statusBox.y).toBeGreaterThanOrEqual((nameBox?.y ?? 0) + (nameBox?.height ?? 0) - 1);
  });
});
