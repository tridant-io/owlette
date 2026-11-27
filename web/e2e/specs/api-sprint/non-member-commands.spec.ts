/**
 * the owner's ruling (adr 0021), "allowlist, refuse the rest": a superadmin with
 * no member row on a site reads it and changes only an allowlist: updating owlette,
 * rebooting, starting, stopping, restarting or killing a configured process,
 * cancelling a deployment, revoking a token, ending a swoop session. everything else,
 * from pairing a machine and shutting it down to fleet settings and talons, waits
 * until they add themselves, which the site's audit log records. super-uid is the
 * superadmin, by key and by session; admin-uid owns the site. live view is gone for
 * swoop, so its command is refused for everyone.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { roleState } from '../../helpers/roles';
import { seedMachine, seedMemberRow, releaseFixtureSite } from '../../helpers/seed';

// the tests build on each other: the last one adds the superadmin to the site
test.describe.configure({ mode: 'serial' });

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-nonmember-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const COMMANDS = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/commands`;

// a published installer, so update_owlette passes isPublishedInstaller
const INSTALLER = { version: '0.0.421', url: 'https://e2e.invalid/Owlette-Installer-v0.0.421.exe', checksum: 'b'.repeat(64) };
const INSTALLER_DOC = `installer_metadata/data/versions/${INSTALLER.version}`;
const pairPhrases: string[] = [];

let superKey: MintedApiKey;
let superSiteKey: MintedApiKey;
let ownerKey: MintedApiKey;

const pending = async () =>
  Object.keys(
    (await getAdminDb().doc(`sites/${SITE_ID}/machines/${MACHINE_ID}/commands/pending`).get()).data() ?? {},
  );

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
  await seedMemberRow(SITE_ID, 'admin-uid', 'owner');
  await seedMachine(SITE_ID, MACHINE_ID);
  await db.doc(INSTALLER_DOC).set({
    version: INSTALLER.version,
    files: { windows_x64: { download_url: INSTALLER.url, checksum_sha256: INSTALLER.checksum } },
  });

  const scopes = [{ resource: 'machine' as const, id: '*', permissions: ['read' as const, 'write' as const] }];
  superKey = await mintApiKey({ ownerUid: 'super-uid', name: `e2e-nonmember-super-${SUFFIX}`, scopes });
  ownerKey = await mintApiKey({ ownerUid: 'admin-uid', name: `e2e-nonmember-owner-${SUFFIX}`, scopes });
  superSiteKey = await mintApiKey({
    ownerUid: 'super-uid',
    name: `e2e-nonmember-super-site-${SUFFIX}`,
    scopes: [
      { resource: 'site', id: SITE_ID, permissions: ['read', 'write', 'admin'] },
      { resource: 'roost', id: '*', permissions: ['read', 'write', 'deploy', 'rollback'] },
    ],
  });
});

test.afterAll(async () => {
  if (superKey) await revokeApiKey(superKey);
  if (ownerKey) await revokeApiKey(ownerKey);
  if (superSiteKey) await revokeApiKey(superSiteKey);
  const db = getAdminDb();
  await db.doc(`sites/${SITE_ID}/machines/${MACHINE_ID}/commands/pending`).delete();
  await db.doc(`sites/${SITE_ID}/machines/${MACHINE_ID}`).delete();
  for (const phrase of pairPhrases) await db.collection('device_codes').doc(phrase).delete();
  await db.doc(INSTALLER_DOC).delete();
  await releaseFixtureSite(SITE_ID, 'super-uid');
  await releaseFixtureSite(SITE_ID);
});

for (const [label, body] of [
  ['a screenshot command', { type: 'capture_screenshot', params: { monitor: 0 } }],
  ['a hoot screenshot', { type: 'mcp_tool_call', params: { tool_name: 'capture_screenshot', tool_params: { monitor: 0 } } }],
  ['a tier-3 tool', { type: 'mcp_tool_call', params: { tool_name: 'run_powershell', tool_params: { script: 'Get-Date' } } }],
  ['a shutdown', { type: 'shutdown_machine', params: {} }],
] as const) {
  test(`a superadmin who is not a member is refused ${label}, and nothing is queued`, async ({ request }) => {
    const res = await request.post(COMMANDS, { headers: authHeaders(superKey), data: body });

    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).code).toBe('members_only');
    expect(await pending()).toEqual([]);
  });
}

test('a superadmin who is not a member is refused a deployment, and nothing is written', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/deployments`, {
    headers: authHeaders(superSiteKey),
    data: {
      name: 'VLC',
      installer_name: 'vlc.exe',
      installer_url: 'https://example.com/vlc.exe',
      silent_flags: '/S',
      machines: [MACHINE_ID],
    },
  });

  expect(res.status(), await res.text()).toBe(403);
  expect((await res.json()).code).toBe('members_only');
  expect(await pending()).toEqual([]);
  expect((await getAdminDb().collection(`sites/${SITE_ID}/deployments`).get()).size).toBe(0);
});

test('a superadmin who is not a member is refused a new roost, and none is created', async ({ request }) => {
  const res = await request.post('/api/roosts', {
    headers: authHeaders(superSiteKey),
    data: { siteId: SITE_ID, name: `e2e roost ${SUFFIX}`, targets: [MACHINE_ID], extractPath: 'C:/show' },
  });

  expect(res.status(), await res.text()).toBe(403);
  expect((await res.json()).code).toBe('members_only');
  expect((await getAdminDb().collection(`sites/${SITE_ID}/roosts`).get()).size).toBe(0);
});

test('a superadmin who is not a member still restarts the machine', async ({ request }) => {
  const res = await request.post(COMMANDS, { headers: authHeaders(superKey), data: { type: 'reboot_machine', params: {} } });

  expect(res.status(), await res.text()).toBe(202);
  const { commandId } = (await res.json()).data as { commandId: string };
  expect(await pending()).toContain(commandId);
});

test('a superadmin who is not a member still updates owlette, to a published installer', async ({ request }) => {
  const res = await request.post(COMMANDS, {
    headers: authHeaders(superKey),
    data: {
      type: 'update_owlette',
      params: { installer_url: INSTALLER.url, checksum_sha256: INSTALLER.checksum, target_version: INSTALLER.version },
    },
  });

  expect(res.status(), await res.text()).toBe(202);
  const { commandId } = (await res.json()).data as { commandId: string };
  expect(await pending()).toContain(commandId);
});

test('a superadmin who is not a member is refused a talon test run, and nothing runs', async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/talons/talon-0001/test`, {
    headers: authHeaders(superSiteKey),
    data: {},
  });

  expect(res.status(), await res.text()).toBe(403);
  expect((await res.json()).code).toBe('members_only');
  expect((await getAdminDb().collection(`sites/${SITE_ID}/talon_runs`).get()).size).toBe(0);
});

test.describe('signed in as the superadmin', () => {
  test.use(roleState('superadmin'));

  test('pairing a machine onto the site is refused, and the code stays pending', async ({ page, playwright }) => {
    // a code made anonymously, as an installer asks for one
    const installer = await playwright.request.newContext({ storageState: { cookies: [], origins: [] } });
    const created = await installer.post('/api/agent/auth/device-code', {
      data: { machineId: `paired-${SUFFIX}`, version: '4.2.7' },
    });
    expect(created.status()).toBe(200);
    const { pairPhrase } = (await created.json()) as { pairPhrase: string };
    await installer.dispose();
    pairPhrases.push(pairPhrase);

    const res = await page.request.post('/api/agent/auth/device-code/authorize', { data: { pairPhrase, siteId: SITE_ID } });

    expect(res.status(), await res.text()).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'members_only' });
    expect((await getAdminDb().collection('device_codes').doc(pairPhrase).get()).data()?.status).toBe('pending');
  });

  test('fleet settings are refused, and none are written', async ({ page }) => {
    const res = await page.request.patch(`/api/sites/${SITE_ID}/fleet-settings`, { data: { enabled: true } });

    expect(res.status(), await res.text()).toBe(403);
    expect((await res.json()).code).toBe('members_only');
    expect((await getAdminDb().doc(`sites/${SITE_ID}/settings/fleet`).get()).exists).toBe(false);
  });

  test('adding themselves to the site succeeds, is audited, and opens its changes to them', async ({ page }) => {
    const res = await page.request.post('/api/users/super-uid/assign-sites', { data: { siteIds: [SITE_ID] } });

    expect(res.status(), await res.text()).toBe(200);
    const db = getAdminDb();
    expect((await db.doc(`sites/${SITE_ID}/members/super-uid`).get()).data()).toMatchObject({ status: 'active' });
    await expect
      .poll(async () =>
        (await db.collection(`sites/${SITE_ID}/audit_queue`).get()).docs
          // the queue holds each event as enqueued, until the drainer moves it to audit_log
          .map((doc) => doc.get('event'))
          .some(
            (row) =>
              row.kind === 'site_member_mutated' && row.target === 'super-uid' && row.attributes?.verb === 'member_added',
          ),
      )
      .toBe(true);

    const fleet = await page.request.patch(`/api/sites/${SITE_ID}/fleet-settings`, { data: { enabled: true } });
    expect(fleet.status(), await fleet.text()).toBe(200);
  });
});

test('start_live_view is refused for the site owner too: live view is gone for swoop', async ({ request }) => {
  const before = await pending();

  const res = await request.post(COMMANDS, {
    headers: authHeaders(ownerKey),
    data: { type: 'start_live_view', params: { interval: 5, duration: 60 } },
  });

  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe('unsupported_command_type');
  expect(await pending()).toEqual(before);
});
