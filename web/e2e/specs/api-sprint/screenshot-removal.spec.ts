/**
 * a machine's screenshots belong to its site: removing the machine deletes its
 * images from storage and its history records, and leaves another machine's; a
 * move deletes them on the site it left, once the target confirms the arrival;
 * deleting the site deletes the rest, and leaves a site whose id starts the same.
 * runs against the storage emulator, which the web app's admin sdk writes to.
 */
import crypto from 'crypto';
import { test, expect } from '@playwright/test';
import { getStorage } from 'firebase-admin/storage';
import { mintApiKey, revokeApiKey, authHeaders, type MintedApiKey } from '../../helpers/apiKey';
import { agentIdToken } from '../../helpers/agentToken';
import { getAdminApp, getAdminDb } from '../../helpers/emulator';
import { seedMachine, seedMemberRow, releaseFixtureSite } from '../../helpers/seed';

const SUFFIX = crypto.randomBytes(4).toString('hex');
const SITE_ID = `e2e-shot-rm-${SUFFIX}`;
const MACHINE_ID = `mach-${SUFFIX}`;
const OTHER_ID = `mach-other-${SUFFIX}`;
const MACHINE_IMAGES = [
  `screenshots/${SITE_ID}/${MACHINE_ID}/1700000000000-aaaaaaaa.jpg`,
  `screenshots/${SITE_ID}/${MACHINE_ID}/1700000000001-bbbbbbbb.jpg`,
];
const OTHER_IMAGE = `screenshots/${SITE_ID}/${OTHER_ID}/1700000000002-cccccccc.jpg`;
const TARGET_ID = `e2e-shot-rm-target-${SUFFIX}`;
const MOVER_ID = `mach-mover-${SUFFIX}`;
const MOVER_IMAGE = `screenshots/${SITE_ID}/${MOVER_ID}/1700000000004-eeeeeeee.jpg`;
// another site's folder that shares the id's start: the site's delete must stop at its own
const NEIGHBOUR_IMAGE = `screenshots/${SITE_ID}-neighbour/${MACHINE_ID}/1700000000003-dddddddd.jpg`;

let key: MintedApiKey;
let siteKey: MintedApiKey;

const bucket = () => getStorage(getAdminApp()).bucket();
const history = (machineId: string) =>
  getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(machineId).collection('screenshots');
const stored = async (path: string) => (await bucket().file(path).exists())[0];

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
  await seedMachine(SITE_ID, OTHER_ID);

  for (const [i, path] of MACHINE_IMAGES.entries()) {
    await bucket().file(path).save(Buffer.from('jpeg'), { contentType: 'image/jpeg' });
    await history(MACHINE_ID).doc(`shot-${i}`).set({ path, url: `/img/${i}`, timestamp: new Date(), sizeKB: 1 });
  }
  await bucket().file(OTHER_IMAGE).save(Buffer.from('jpeg'), { contentType: 'image/jpeg' });
  await history(OTHER_ID).doc('shot-other').set({ path: OTHER_IMAGE, url: '/img/o', timestamp: new Date(), sizeKB: 1 });
  await bucket().file(NEIGHBOUR_IMAGE).save(Buffer.from('jpeg'), { contentType: 'image/jpeg' });

  // a machine switching to another site: the move fetched the target's tokens and
  // its agent already heartbeats there, so only the arrival is left to confirm
  await db.collection('sites').doc(TARGET_ID).set({ name: TARGET_ID, owner: 'admin-uid', timezone: 'UTC', createdAt: new Date() });
  await seedMemberRow(TARGET_ID, 'admin-uid', 'owner');
  await seedMachine(SITE_ID, MOVER_ID);
  await seedMachine(TARGET_ID, MOVER_ID);
  await bucket().file(MOVER_IMAGE).save(Buffer.from('jpeg'), { contentType: 'image/jpeg' });
  await history(MOVER_ID).doc('shot-mover').set({ path: MOVER_IMAGE, url: '/img/m', timestamp: new Date(), sizeKB: 1 });
  await db.doc(`machine_moves/${SITE_ID}:${MOVER_ID}`).set({
    moveId: `${SITE_ID}:${MOVER_ID}`,
    sourceSiteId: SITE_ID,
    targetSiteId: TARGET_ID,
    machineId: MOVER_ID,
    status: 'switching',
    requestedBy: 'admin-uid',
    requestedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  key = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-shot-rm-${SUFFIX}`,
    scopes: [{ resource: 'machine', id: '*', permissions: ['read', 'write'] }],
  });
  siteKey = await mintApiKey({
    ownerUid: 'admin-uid',
    name: `e2e-shot-rm-site-${SUFFIX}`,
    scopes: [{ resource: 'site', id: SITE_ID, permissions: ['read', 'write', 'admin'] }],
  });
});

test.afterAll(async () => {
  if (key) await revokeApiKey(key);
  if (siteKey) await revokeApiKey(siteKey);
  await bucket().file(OTHER_IMAGE).delete({ ignoreNotFound: true });
  await bucket().file(NEIGHBOUR_IMAGE).delete({ ignoreNotFound: true });
  await history(OTHER_ID).doc('shot-other').delete();
  for (const machineId of [MACHINE_ID, OTHER_ID]) {
    await getAdminDb().collection('sites').doc(SITE_ID).collection('machines').doc(machineId).delete();
  }
  await getAdminDb().doc(`sites/${TARGET_ID}/machines/${MOVER_ID}`).delete();
  await getAdminDb().doc(`machine_moves/${SITE_ID}:${MOVER_ID}`).delete();
  await releaseFixtureSite(TARGET_ID);
  await releaseFixtureSite(SITE_ID);
});

test("removing a machine deletes its screenshots, images and records, and leaves another machine's", async ({ request }) => {
  for (const path of MACHINE_IMAGES) expect(await stored(path)).toBe(true);
  expect((await history(MACHINE_ID).get()).size).toBe(2);

  const res = await request.delete(`/api/sites/${SITE_ID}/machines/${MACHINE_ID}`, {
    headers: authHeaders(key),
  });
  expect(res.status()).toBe(200);

  for (const path of MACHINE_IMAGES) expect(await stored(path)).toBe(false);
  expect((await history(MACHINE_ID).get()).size).toBe(0);

  expect(await stored(OTHER_IMAGE)).toBe(true);
  expect((await history(OTHER_ID).get()).size).toBe(1);
});

test('a move deletes the screenshots on the site the machine left, once the target confirms it', async ({ request }) => {
  expect(await stored(MOVER_IMAGE)).toBe(true);

  const res = await request.post('/api/agent/auth/move/confirm', {
    headers: { Authorization: `Bearer ${await agentIdToken(TARGET_ID, MOVER_ID)}` },
    data: { machineId: MOVER_ID, moveId: `${SITE_ID}:${MOVER_ID}` },
  });
  expect(res.status(), await res.text()).toBe(200);

  expect(await stored(MOVER_IMAGE)).toBe(false);
  expect((await history(MOVER_ID).get()).size).toBe(0);
  // the machine arrived: its row on the target is untouched
  expect((await getAdminDb().doc(`sites/${TARGET_ID}/machines/${MOVER_ID}`).get()).exists).toBe(true);
  expect(await stored(OTHER_IMAGE)).toBe(true);
});

test("deleting the site deletes every machine's screenshots, and no other site's", async ({ request }) => {
  const res = await request.delete(`/api/sites/${SITE_ID}`, { headers: authHeaders(siteKey) });
  expect(res.status()).toBe(200);

  expect(await stored(OTHER_IMAGE)).toBe(false);
  expect((await history(OTHER_ID).get()).size).toBe(0);
  expect(await stored(NEIGHBOUR_IMAGE)).toBe(true);
});
