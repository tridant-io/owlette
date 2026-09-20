/**
 * @jest-environment node
 *
 * `sites/{siteId}/machines/{machineId}/swoop_sessions/{sid}` is server-only.
 *
 * plan.md D12: no `firestore.rules` change accompanies swoop. There is no
 * explicit rule for this subcollection and the only recursive wildcard in the
 * file is `/{path=**}/members/{memberUid}`, so the catch-all deny at the bottom
 * covers it. This spec is what stops that becoming true by accident — a later
 * `match /machines/{machineId}/{document=**}` anywhere above would open every
 * session document to every site member, and only a test notices.
 *
 * `firestore.rules` is NOT modified by this task; this asserts against the file
 * exactly as it ships.
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
const SID = 'sid-1';

const MEMBER_UID = 'member-uid';
const ADMIN_UID = 'admin-uid';
const OWNER_UID = 'owner-uid';
const SUPER_UID = 'super-uid';

function sessionPath(db: Firestore) {
  return doc(db, 'sites', SITE, 'machines', MACHINE, 'swoop_sessions', SID);
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
    await setDoc(doc(db, 'sites', SITE), { owner: OWNER_UID, name: 'Site A' });
    await setDoc(doc(db, 'sites', SITE, 'machines', MACHINE), {
      online: true,
      lastHeartbeat: Date.now(),
    });
    // The server writes this document through the admin SDK, which bypasses
    // rules — so a read denial below is a real denial, not an empty collection.
    await setDoc(doc(db, 'sites', SITE, 'machines', MACHINE, 'swoop_sessions', SID), {
      sid: SID,
      siteId: SITE,
      machineId: MACHINE,
      state: 'live',
      createdBy: ADMIN_UID,
      viewers: [],
    });
  });
});

describe('swoop_sessions is denied to every client context', () => {
  const cases: Array<[string, () => Promise<Firestore> | Firestore]> = [
    ['a site member', () => asUser(MEMBER_UID, 'member', [SITE])],
    ['a site admin', () => asUser(ADMIN_UID, 'admin', [SITE])],
    ['the site owner', () => asUser(OWNER_UID, 'member', [SITE], { [SITE]: 'owner' })],
    ['a superadmin', () => asUser(SUPER_UID, 'superadmin', [SITE])],
    ['the machine agent', () => asAgent(SITE, MACHINE)],
    ['an unauthenticated client', () => asUnauthenticated()],
  ];

  it.each(cases)('denies %s a read', async (_label, context) => {
    const db = await context();
    await assertFails(getDoc(sessionPath(db)));
  });

  it.each(cases)('denies %s a write', async (_label, context) => {
    const db = await context();
    await assertFails(setDoc(sessionPath(db), { state: 'ended', endReason: 'killed' }));
  });

  it.each(cases)('denies %s a delete', async (_label, context) => {
    const db = await context();
    await assertFails(deleteDoc(sessionPath(db)));
  });
});

describe('creating a session document from a client is denied too', () => {
  it('denies a site admin creating a new sid', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE]);
    await assertFails(
      setDoc(doc(db, 'sites', SITE, 'machines', MACHINE, 'swoop_sessions', 'sid-forged'), {
        sid: 'sid-forged',
        state: 'live',
      }),
    );
  });

  it('denies the agent creating a session for its own machine', async () => {
    const db = asAgent(SITE, MACHINE);
    await assertFails(
      setDoc(doc(db, 'sites', SITE, 'machines', MACHINE, 'swoop_sessions', 'sid-agent'), {
        sid: 'sid-agent',
        state: 'live',
      }),
    );
  });
});
