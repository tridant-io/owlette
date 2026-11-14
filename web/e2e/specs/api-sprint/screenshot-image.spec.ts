/**
 * Screenshot records over the real routes: the image route opens only this
 * machine's screenshots, and only the machine's own agent records a capture.
 * The signed redirect itself needs storage signing credentials the emulator
 * rig does not have, so the jest suite covers it (screenshot-storage.test.ts).
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedMemberRow, releaseFixtureSite } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-shot-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const IMAGE_ROUTE = `/api/sites/${SITE_ID}/machines/${MACHINE_ID}/screenshots/image`;

let readKey: MintedApiKey;
let writeKey: MintedApiKey;

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

  readKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-shot-read-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read'] }],
  });
  writeKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-shot-write-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }],
  });
});

test.afterAll(async () => {
  if (readKey) await revokeApiKey(readKey);
  if (writeKey) await revokeApiKey(writeKey);
  await releaseFixtureSite(SITE_ID);
});

test('GET .../screenshots/image without credentials is 401', async ({ request }) => {
  const path = encodeURIComponent(`screenshots/${SITE_ID}/${MACHINE_ID}/1.jpg`);
  const res = await request.get(`${IMAGE_ROUTE}?path=${path}`, { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});

for (const [label, storagePath] of [
  ['another site', `screenshots/site-A/${MACHINE_ID}/1.jpg`],
  ['another machine', `screenshots/${SITE_ID}/other-machine/1.jpg`],
  ['another folder', 'chat-images/admin-uid/chat-1/1.jpg'],
] as const) {
  test(`GET .../screenshots/image refuses a path in ${label}`, async ({ request }) => {
    const res = await request.get(`${IMAGE_ROUTE}?path=${encodeURIComponent(storagePath)}`, {
      headers: authHeaders(readKey, false),
      maxRedirects: 0,
    });
    expect(res.status()).toBe(400);
    expect(res.headers()['location']).toBeUndefined();
  });
}

test("POST .../screenshots/finalize refuses anyone but the machine's agent", async ({ request }) => {
  const res = await request.post(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}/screenshots/finalize`, {
    headers: authHeaders(writeKey),
    data: { storagePath: `screenshots/${SITE_ID}/${MACHINE_ID}/1.jpg`, sizeKB: 1 },
  });
  expect(res.status()).toBe(403);

  const machine = await getAdminDb()
    .collection('sites')
    .doc(SITE_ID)
    .collection('machines')
    .doc(MACHINE_ID)
    .get();
  expect(machine.data()?.lastScreenshot).toBeUndefined();
});
