/**
 * machine-api e2e against POST /api/sites/{s}/machines/{m}/commands and GET .../{commandId} with a
 * `machine=*:write|read` key. Reboot + screenshot are exercised; shutdown_machine shares the same
 * handler, so the dispatch test covers all three branches.
 *
 * Negatives: 409 machine_offline (online=false), 409 held_restart_unsupported (a restart held for
 * active hours to an agent that would run it at once), 403 scope_insufficient (no machine:write).
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedMemberRow, releaseFixtureSite } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-cmd-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const OFFLINE_MACHINE_ID = `mach-offline-${SUFFIX}`;
const GUARDED_MACHINE_ID = `mach-guarded-${SUFFIX}`;
const STALE_MACHINE_ID = `mach-stale-${SUFFIX}`;
const MACHINE_IDS = [MACHINE_ID, OFFLINE_MACHINE_ID, GUARDED_MACHINE_ID, STALE_MACHINE_ID];

let writeKey: MintedApiKey;
let readOnlyKey: MintedApiKey;

async function clearPending(machineId: string): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending')
    .delete()
    .catch(() => undefined);
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed')
    .delete()
    .catch(() => undefined);
}

test.beforeAll(async () => {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(SITE_ID)
    .set({ name: SITE_ID, owner: 'admin-uid', timezone: 'UTC', createdAt: new Date() });
  await db
    .collection('users')
    .doc('admin-uid')
    .update({ sites: [...new Set(['site-A', SITE_ID])] });
  // Ownership is a member row since wave 5.1; the `owner` field above grants
  // nothing, so without this the api key cannot reach its own site.
  await seedMemberRow(SITE_ID, 'admin-uid', 'owner');

  // Online + offline machines on one site, so both branches are reachable.
  await seedMachine(SITE_ID, MACHINE_ID);
  await seedMachine(SITE_ID, OFFLINE_MACHINE_ID);
  await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(OFFLINE_MACHINE_ID)
    .update({ online: false });
  // the active-hours guard holds a restart on 4.1.21; a machine rolled back to
  // 3.3.7 keeps the capability its old agent never clears, and restarts at once.
  await seedMachine(SITE_ID, GUARDED_MACHINE_ID, { activeHoursGuard: true });
  await seedMachine(SITE_ID, STALE_MACHINE_ID, { activeHoursGuard: true, agentVersion: '3.3.7' });

  writeKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-cmd-write-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }],
  });
  readOnlyKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-cmd-read-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read'] }],
  });
});

test.afterAll(async () => {
  if (writeKey) await revokeApiKey(writeKey);
  if (readOnlyKey) await revokeApiKey(readOnlyKey);
  await Promise.all(MACHINE_IDS.map(clearPending));
  await releaseFixtureSite(SITE_ID);
});

test.beforeEach(async () => {
  await Promise.all(MACHINE_IDS.map(clearPending));
});

async function pendingCommands(machineId: string): Promise<Record<string, { type?: string; when?: string }>> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending')
    .get();
  return (snap.data() ?? {}) as Record<string, { type?: string; when?: string }>;
}

test('POST /api/sites/{s}/machines/{m}/commands — dispatch reboot returns 202 + commandId', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(writeKey),
    data: {
      type: 'reboot_machine',
      params: { delay_seconds: 30 },
      timeout_seconds: 60,
    },
  });
  expect(res.status()).toBe(202);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(typeof body.data?.commandId).toBe('string');
  expect(body.data.commandId).toMatch(/^cmd_/);
  expect(body.data.status).toBe('pending');

  const db = getAdminDb();
  const pendingSnap = await db
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .collection('commands')
    .doc('pending')
    .get();
  expect(pendingSnap.exists).toBe(true);
  const cmd = pendingSnap.data()?.[body.data.commandId];
  expect(cmd?.type).toBe('reboot_machine');
});

test('POST + GET /api/sites/{s}/machines/{m}/commands/{commandId} — dispatch screenshot, then poll', async ({ request }) => {
  const dispatchRes = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(writeKey),
    data: {
      type: 'capture_screenshot',
      params: { monitor: 'all' },
    },
  });
  expect(dispatchRes.status()).toBe(202);
  const dispatchBody = await dispatchRes.json();
  const commandId = dispatchBody.data.commandId;

  const pollRes = await request.get(
    `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands/${commandId}`,
    { headers: authHeaders(readOnlyKey, false) },
  );
  expect(pollRes.status()).toBe(200);
  const pollBody = await pollRes.json();
  expect(pollBody.ok).toBe(true);
  expect(pollBody.data.commandId).toBe(commandId);
  expect(['pending', 'in_progress']).toContain(pollBody.data.status);
});

test('POST /api/sites/{s}/machines/{m}/commands — 409 machine_offline when machine.online=false', async ({ request }) => {
  const res = await request.post(
    `/api/sites/${SITE_ID}/machines/${OFFLINE_MACHINE_ID}/commands`,
    {
      headers: authHeaders(writeKey),
      data: { type: 'reboot_machine' },
    },
  );
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('machine_offline');
});

for (const [label, machineId] of [
  ['an agent without the active-hours guard', MACHINE_ID],
  ['a stale guard capability on a 3.3.7 agent', STALE_MACHINE_ID],
] as const) {
  test(`POST /api/sites/{s}/machines/{m}/commands — 409 held_restart_unsupported to ${label}, nothing queued`, async ({ request }) => {
    const res = await request.post(`/api/sites/${SITE_ID}/machines/${machineId}/commands`, {
      headers: authHeaders(writeKey),
      data: { type: 'reboot_machine', params: { when: 'after_active_hours' } },
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('held_restart_unsupported');
    // the neutral reason, with no advice meant for a model
    expect(body.detail).toMatch(/so nothing was sent\.$/);
    expect(await pendingCommands(machineId)).toEqual({});
  });
}

test('POST /api/sites/{s}/machines/{m}/commands — a held restart to a guarded 4.1.21 agent is queued', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${GUARDED_MACHINE_ID}/commands`, {
    headers: authHeaders(writeKey),
    data: { type: 'reboot_machine', params: { when: 'after_active_hours' } },
  });
  expect(res.status()).toBe(202);
  const body = await res.json();
  const pending = await pendingCommands(GUARDED_MACHINE_ID);
  expect(pending[body.data.commandId]).toMatchObject({ type: 'reboot_machine', when: 'after_active_hours' });
});

test('POST /api/sites/{s}/machines/{m}/commands — read-only key gets 403', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`, {
    headers: authHeaders(readOnlyKey),
    data: { type: 'reboot_machine' },
  });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('scope_insufficient');
});
