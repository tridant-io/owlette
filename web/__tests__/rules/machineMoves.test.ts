/**
 * @jest-environment node
 *
 * `machine_moves/{sourceSiteId}:{machineId}` is server-only. there is no rule
 * for it: the catch-all deny at the bottom of `firestore.rules` covers it. this
 * spec stops that changing by accident. a client able to write one could point
 * a machine at a site it does not administer, or flip a move to `switching` and
 * let the agent mint the target's credentials; one able to read them could map
 * which machines are leaving which sites.
 *
 * `firestore.rules` is not modified; this asserts against the file as it ships.
 */

import { assertFails } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';
import {
  asAgent,
  asUnauthenticated,
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE = 'site-A';
const TARGET_SITE = 'site-B';
const MACHINE = 'machine-X';
const MOVE = `${SITE}:${MACHINE}`;
const move = (machineId = MACHINE) => ({
  moveId: `${SITE}:${machineId}`,
  sourceSiteId: SITE,
  targetSiteId: TARGET_SITE,
  machineId,
  status: 'pending',
  requestedBy: 'admin-uid',
  requestedAt: Date.now(),
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
});

const everyClient: Array<[string, () => Promise<Firestore> | Firestore]> = [
  ['the source site owner', () => asUser('owner-uid', 'member', [SITE], { [SITE]: 'owner' })],
  ['a source site admin', () => asUser('admin-uid', 'admin', [SITE])],
  ['a source site member', () => asUser('member-uid', 'member', [SITE])],
  ['a target site admin', () => asUser('target-admin-uid', 'admin', [TARGET_SITE])],
  ['an admin of both sites', () => asUser('both-admin-uid', 'admin', [SITE, TARGET_SITE])],
  ['a superadmin', () => asUser('super-uid', 'superadmin', [SITE])],
  ['the machine agent on the source site', () => asAgent(SITE, MACHINE)],
  ['the machine agent on the target site', () => asAgent(TARGET_SITE, MACHINE)],
  ['an unauthenticated client', () => asUnauthenticated()],
];

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  // written with rules disabled, so a denied read below is a real denial.
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE), { owner: 'owner-uid', name: 'Site A' });
    await setDoc(doc(db, 'sites', TARGET_SITE), { owner: 'other-owner', name: 'Site B' });
    await setDoc(doc(db, 'machine_moves', MOVE), move());
  });
});

describe('machine_moves is denied to every client context', () => {
  it.each(everyClient)('denies %s a read of a move', async (_who, context) => {
    const db = await context();
    await assertFails(getDoc(doc(db, 'machine_moves', MOVE)));
  });

  it.each(everyClient)('denies %s listing the moves', async (_who, context) => {
    const db = await context();
    await assertFails(getDocs(collection(db, 'machine_moves')));
  });

  it.each(everyClient)('denies %s writing a move', async (_who, context) => {
    const db = await context();
    await assertFails(setDoc(doc(db, 'machine_moves', `${SITE}:machine-Y`), move('machine-Y')));
  });

  it.each(everyClient)('denies %s turning a move to switching', async (_who, context) => {
    const db = await context();
    await assertFails(updateDoc(doc(db, 'machine_moves', MOVE), { status: 'switching' }));
  });

  it.each(everyClient)('denies %s deleting a move', async (_who, context) => {
    const db = await context();
    await assertFails(deleteDoc(doc(db, 'machine_moves', MOVE)));
  });
});
