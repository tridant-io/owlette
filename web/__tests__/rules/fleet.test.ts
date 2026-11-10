/**
 * @jest-environment node
 *
 * the two documents the fleet routes add, against `firestore.rules` as it ships.
 *
 * `fleet_sessions/*` holds the hash of a machine's fleet session. there is no
 * rule for it: the catch-all deny at the bottom of `firestore.rules` covers it.
 * a client able to read or write one could give itself a machine's reach over
 * its site.
 *
 * `sites/{siteId}/settings/fleet` is the grant. the generic settings rule lets
 * a site's people read it and only the server write it. a client able to write
 * it could grant any machine any tier.
 *
 * `firestore.rules` is not modified; this stops either changing by accident.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
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
const OTHER_SITE = 'site-B';
const MACHINE = 'machine-X';
const SESSION = 'a'.repeat(64);

const OWNER_UID = 'owner-uid';
const ADMIN_UID = 'admin-uid';
const MEMBER_UID = 'member-uid';
const SUPER_UID = 'super-uid';
const OUTSIDER_UID = 'outsider-uid';

type Context = [string, () => Promise<Firestore> | Firestore];

const sitePeople: Context[] = [
  ['the site owner', () => asUser(OWNER_UID, 'member', [SITE], { [SITE]: 'owner' })],
  ['a site admin', () => asUser(ADMIN_UID, 'admin', [SITE])],
  ['a site member', () => asUser(MEMBER_UID, 'member', [SITE])],
];

const outsiders: Context[] = [
  ['a member of another site', () => asUser(OUTSIDER_UID, 'member', [OTHER_SITE])],
  ['an unauthenticated client', () => asUnauthenticated()],
];

const everyClient: Context[] = [
  ...sitePeople,
  ['a superadmin', () => asUser(SUPER_UID, 'superadmin', [SITE])],
  ['the machine agent', () => asAgent(SITE, MACHINE)],
  ...outsiders,
];

const grant = { enabled: true, senders: { [MACHINE]: { maxTier: 3, targets: null } } };

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
    await setDoc(doc(db, 'sites', SITE), { owner: OWNER_UID, name: 'Site A' });
    await setDoc(doc(db, 'sites', OTHER_SITE), { owner: 'other-owner', name: 'Site B' });
    await setDoc(doc(db, 'sites', SITE, 'settings', 'fleet'), {
      enabled: false,
      senders: {},
    });
    await setDoc(doc(db, 'fleet_sessions', SESSION), {
      siteId: SITE,
      machineId: MACHINE,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  });
});

describe('fleet_sessions is denied to every client context', () => {
  it.each(everyClient)('denies %s a read of a session', async (_who, context) => {
    const db = await context();
    await assertFails(getDoc(doc(db, 'fleet_sessions', SESSION)));
  });

  it.each(everyClient)('denies %s listing the sessions', async (_who, context) => {
    const db = await context();
    await assertFails(getDocs(collection(db, 'fleet_sessions')));
  });

  it.each(everyClient)('denies %s writing a session', async (_who, context) => {
    const db = await context();
    await assertFails(
      setDoc(doc(db, 'fleet_sessions', 'b'.repeat(64)), {
        siteId: SITE,
        machineId: MACHINE,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      }),
    );
  });

  it.each(everyClient)('denies %s deleting a session', async (_who, context) => {
    const db = await context();
    await assertFails(deleteDoc(doc(db, 'fleet_sessions', SESSION)));
  });
});

describe('the grant is read by the site and written only by the server', () => {
  it.each(sitePeople)('lets %s read the grant', async (_who, context) => {
    const db = await context();
    await assertSucceeds(getDoc(doc(db, 'sites', SITE, 'settings', 'fleet')));
  });

  it('lets a superadmin read the grant', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', [SITE]);
    await assertSucceeds(getDoc(doc(db, 'sites', SITE, 'settings', 'fleet')));
  });

  it.each(outsiders)('denies %s a read of the grant', async (_who, context) => {
    const db = await context();
    await assertFails(getDoc(doc(db, 'sites', SITE, 'settings', 'fleet')));
  });

  // a machine learns whether it holds a grant from the session route, never from firestore.
  it('denies the machine agent a read of the grant', async () => {
    await assertFails(getDoc(doc(asAgent(SITE, MACHINE), 'sites', SITE, 'settings', 'fleet')));
  });

  it.each(everyClient)('denies %s writing the grant', async (_who, context) => {
    const db = await context();
    await assertFails(setDoc(doc(db, 'sites', SITE, 'settings', 'fleet'), grant));
  });

  it.each(everyClient)('denies %s deleting the grant', async (_who, context) => {
    const db = await context();
    await assertFails(deleteDoc(doc(db, 'sites', SITE, 'settings', 'fleet')));
  });
});
