/**
 * @jest-environment node
 *
 * `billing_usage/**`, `plan_snapshot/*`, `plan_accounts/*` and `billing_checkouts/*` are server-only.
 *
 * there is no rule for either: the catch-all deny at the bottom of
 * `firestore.rules` covers them. this spec stops that changing by accident. a
 * payer able to write their own snapshot could switch scheduled rollouts back
 * on for a lapsed plan, and one able to write usage could shrink their bill.
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
const DAY = '2026-10-07';
const SESSION = 'cs_test_1';

const OWNER_UID = 'owner-uid';
const MEMBER_UID = 'member-uid';
const ADMIN_UID = 'admin-uid';
const SUPER_UID = 'super-uid';

const paths: Array<[string, (db: Firestore) => DocumentReference]> = [
  ['the site’s usage parent', (db) => doc(db, 'billing_usage', SITE)],
  ['a usage day', (db) => doc(db, 'billing_usage', SITE, 'days', DAY)],
  ['the plan snapshot', (db) => doc(db, 'plan_snapshot', SITE)],
  ['a plan account', (db) => doc(db, 'plan_accounts', OWNER_UID)],
  ['a billing checkout', (db) => doc(db, 'billing_checkouts', SESSION)],
];

const contexts: Array<[string, () => Promise<Firestore> | Firestore]> = [
  ['the payer (site owner)', () => asUser(OWNER_UID, 'member', [SITE], { [SITE]: 'owner' })],
  ['a site admin', () => asUser(ADMIN_UID, 'admin', [SITE])],
  ['a site member', () => asUser(MEMBER_UID, 'member', [SITE])],
  ['a superadmin', () => asUser(SUPER_UID, 'superadmin', [SITE])],
  ['the machine agent', () => asAgent(SITE, MACHINE)],
  ['an unauthenticated client', () => asUnauthenticated()],
];

const cases = contexts.flatMap(([who, context]) =>
  paths.map(([what, ref]) => [who, what, context, ref] as const),
);

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
    await setDoc(doc(db, 'billing_usage', SITE, 'days', DAY), {
      machineIds: [MACHINE],
      updatedAt: new Date(),
    });
    await setDoc(doc(db, 'plan_snapshot', SITE), {
      enforced: true,
      control: false,
      roost: false,
      resolvedAt: new Date(),
    });
    await setDoc(doc(db, 'plan_accounts', OWNER_UID), { trialEndsAt: 1, orgId: 'org_1', linkRequired: false });
    await setDoc(doc(db, 'billing_checkouts', SESSION), { uid: OWNER_UID, siteId: SITE, tier: 'pro', founders: false });
  });
});

describe('billing_usage, plan_snapshot, plan_accounts and billing_checkouts are denied to every client context', () => {
  it.each(cases)('denies %s a read of %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(getDoc(ref(db)));
  });

  it.each(cases)('denies %s a write to %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(setDoc(ref(db), { enforced: false, control: true, roost: true, machineIds: [] }));
  });

  it.each(cases)('denies %s a delete of %s', async (_who, _what, context, ref) => {
    const db = await context();
    await assertFails(deleteDoc(ref(db)));
  });

  it.each(contexts)('denies %s listing the usage days, snapshots, accounts or checkouts', async (_who, context) => {
    const db = await context();
    await assertFails(getDocs(collection(db, 'billing_usage', SITE, 'days')));
    await assertFails(getDocs(collection(db, 'plan_snapshot')));
    await assertFails(getDocs(collection(db, 'plan_accounts')));
    await assertFails(getDocs(collection(db, 'billing_checkouts')));
  });
});
