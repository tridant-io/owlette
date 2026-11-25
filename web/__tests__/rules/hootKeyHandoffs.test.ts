/**
 * @jest-environment node
 *
 * `sites/{siteId}/machines/{machineId}/hoot_key_handoffs/{keyId}` is server-only:
 * no rule matches it, so the catch-all deny covers it. the agent reads it only
 * through `/api/agent/hoot/key`. this spec stops a later wildcard opening it.
 */

import { assertFails } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore';
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
const MACHINE = 'machine-X';
const KEY_ID = 'key-1';

function keyPath(db: Firestore) {
  return doc(db, 'sites', SITE, 'machines', MACHINE, 'hoot_key_handoffs', KEY_ID);
}

beforeAll(async () => {
  await initRulesHarness();
});

afterAll(async () => {
  await cleanupRulesHarness();
});

beforeEach(async () => {
  await clearFirestoreData();

  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', SITE), { owner: 'owner-uid', name: 'Site A' });
    await setDoc(doc(db, 'sites', SITE, 'machines', MACHINE), { online: true });
    await setDoc(keyPath(db), { apiKeyEncrypted: 'ciphertext' });
  });
});

describe('hoot_key_handoffs is denied to every client context', () => {
  const cases: Array<[string, () => Promise<Firestore> | Firestore]> = [
    ['a site member', () => asUser('member-uid', 'member', [SITE])],
    ['a site admin', () => asUser('admin-uid', 'admin', [SITE])],
    ['the site owner', () => asUser('owner-uid', 'member', [SITE], { [SITE]: 'owner' })],
    ['a superadmin', () => asUser('super-uid', 'superadmin', [SITE])],
    ['the machine agent', () => asAgent(SITE, MACHINE)],
    ['an unauthenticated client', () => asUnauthenticated()],
  ];

  it.each(cases)('denies %s a read', async (_label, context) => {
    await assertFails(getDoc(keyPath(await context())));
  });

  it.each(cases)('denies %s a write', async (_label, context) => {
    await assertFails(setDoc(keyPath(await context()), { apiKeyEncrypted: 'forged' }));
  });

  it.each(cases)('denies %s a delete', async (_label, context) => {
    await assertFails(deleteDoc(keyPath(await context())));
  });
});
