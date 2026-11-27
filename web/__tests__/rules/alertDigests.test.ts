/**
 * @jest-environment node
 *
 * `alert_digests/{uid}`, its `digest_events` and `global/alert_digest` are
 * server-only. There is no rule for them: the catch-all deny at the bottom of
 * `firestore.rules` covers them, and this spec stops that changing by accident.
 * A person able to read their own queue could read the site and machine names of
 * a site they were removed from before the send-time check drops the rows, and
 * one able to write it could mark a period sent or plant rows in it.
 *
 * `firestore.rules` is not modified; this asserts against the file as it ships.
 */

import { assertFails } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import type { DocumentReference, Firestore } from 'firebase/firestore';
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
const MACHINE = 'machine-X';
const OWNER_UID = 'owner-uid';
const SUPER_UID = 'super-uid';

const paths: Array<[string, (db: Firestore) => DocumentReference]> = [
  ['their own digest state', (db) => doc(db, 'alert_digests', OWNER_UID)],
  ['a queued digest row of their own', (db) => doc(db, 'alert_digests', OWNER_UID, 'digest_events', 'e1')],
  ['the digest job status', (db) => doc(db, 'global', 'alert_digest')],
];

const contexts: Array<[string, () => Promise<Firestore> | Firestore]> = [
  ['the person the digest is for', () => asUser(OWNER_UID, 'member', [SITE], { [SITE]: 'owner' })],
  ['a superadmin', () => asUser(SUPER_UID, 'superadmin', [SITE])],
  ['the machine agent', () => asAgent(SITE, MACHINE)],
  ['an unauthenticated client', () => asUnauthenticated()],
];

const cases = contexts.flatMap(([who, context]) => paths.map(([what, ref]) => [who, what, context, ref] as const));

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  // written through the admin sdk, which bypasses rules, so a denied read below is a real denial.
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE), { owner: OWNER_UID, name: 'Site A' });
    await setDoc(doc(db, 'alert_digests', OWNER_UID), { pending: true, lastQueuedAt: new Date() });
    await setDoc(doc(db, 'alert_digests', OWNER_UID, 'digest_events', 'e1'), {
      siteId: SITE,
      machineId: MACHINE,
      category: 'healthAlerts',
      kind: 'offline',
      queuedAt: new Date(),
    });
    await setDoc(doc(db, 'global', 'alert_digest'), { lastRunAt: 1 });
  });
});

describe('alert_digests and global/alert_digest are denied to every client context', () => {
  it.each(cases)('denies %s a read of %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(getDoc(ref(db)));
  });

  it.each(cases)('denies %s a write to %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(setDoc(ref(db), { pending: false, lastSentPeriodKey: 'daily:forged' }));
  });

  it.each(cases)('denies %s a delete of %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(deleteDoc(ref(db)));
  });

  it.each(contexts)('denies %s listing the digests or a queue', async (_who, context) => {
    const db = await context();
    await assertFails(getDocs(collection(db, 'alert_digests')));
    await assertFails(getDocs(collection(db, 'alert_digests', OWNER_UID, 'digest_events')));
  });
});
