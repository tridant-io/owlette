/**
 * @jest-environment node
 *
 * Per-site membership rules — wave 4 of dev/active/per-site-roles.
 *
 * Site access moved from two legacy fields (`sites/{siteId}.owner` and
 * `users/{uid}.sites[]`) to a document, `sites/{siteId}/members/{uid}`. The
 * existing 95 rules tests stayed green across that cut, which on its own proves
 * nothing — they seed through `asUser`, which now writes member rows too, so
 * they would pass either way.
 *
 * This file is the control. The first describe block asserts the legacy fields
 * are genuinely DEAD: a user carrying `sites: [SITE_A]` and a site carrying
 * `owner: <uid>` gets nothing without a member row. If someone reinstates a
 * legacy read in `canAccessSite`, those tests go green-to-red and this file has
 * earned its place.
 *
 * It also covers the client read path Wave 4.2 depends on — the
 * `collectionGroup('members')` query — including the half that matters, which is
 * that it cannot reach another user's rows.
 *
 * RUN: `npm run test:rules` — needs the emulator on :8080, so the default jest
 * run skips it.
 */

import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  asUser,
  cleanupRulesHarness,
  clearFirestoreData,
  initRulesHarness,
  seedAsAdmin,
} from './harness';

const SITE_A = 'site-A';
const SITE_B = 'site-B';

const MEMBER_UID = 'member-uid';
const ADMIN_UID = 'admin-uid';
const OWNER_UID = 'owner-uid';
const OTHER_UID = 'other-uid';
const SUPER_UID = 'super-uid';
const DELETED_UID = 'deleted-uid';

/** Write a membership row directly, bypassing rules. */
async function seedMember(
  siteId: string,
  uid: string,
  role: 'owner' | 'admin' | 'member',
  status: 'active' | 'invited' = 'active',
): Promise<void> {
  await seedAsAdmin(async (db) => {
    await setDoc(doc(db, 'sites', siteId, 'members', uid), {
      uid,
      role,
      status,
      addedAt: new Date(),
      addedBy: 'system:rules-harness',
    });
  });
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
    await setDoc(doc(db, 'sites', SITE_A), { owner: 'someone-else', name: 'Site A' });
    await setDoc(doc(db, 'sites', SITE_B), { owner: 'someone-else', name: 'Site B' });
    await setDoc(doc(db, 'sites', SITE_A, 'machines', 'machine-X'), {
      online: true,
      lastHeartbeat: Date.now(),
    });
  });
});

describe('legacy fields are dead (negative control)', () => {
  test('users/{uid}.sites[] alone grants NO access', async () => {
    // Build the context with no sites so `asUser` seeds no member row, then
    // restate the user document the old way: `sites: [SITE_A]` and nothing else.
    const db = await asUser(OTHER_UID, 'member', []);
    await seedAsAdmin(async (adminDb) => {
      await setDoc(doc(adminDb, 'users', OTHER_UID), {
        uid: OTHER_UID,
        email: `${OTHER_UID}@harness.test`,
        role: 'member',
        sites: [SITE_A],
      });
    });

    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('sites/{siteId}.owner alone grants NO access', async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_B), { owner: OWNER_UID, name: 'Site B' });
    });
    const db = await asUser(OWNER_UID, 'member', []);

    await assertFails(getDoc(doc(db, 'sites', SITE_B)));
  });

  test('global role `admin` grants NO site access without a member row', async () => {
    // The headline semantic change: global admin was site-wide reach, and is now
    // worth nothing on a site the user holds no membership for.
    const db = await asUser(ADMIN_UID, 'admin', []);

    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
    await assertFails(getDoc(doc(db, 'sites', SITE_A, 'machines', 'machine-X')));
  });
});

describe('membership grants access', () => {
  test('active member can read the site and its machines', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A, 'machines', 'machine-X')));
  });

  test('membership on site A does not reach site B', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(getDoc(doc(db, 'sites', SITE_B)));
  });

  test('a non-active membership grants nothing', async () => {
    // `status` is present from day one so invitations can land later without a
    // migration. An invited row must not read as a grant.
    const db = await asUser(OTHER_UID, 'member', []);
    await seedMember(SITE_A, OTHER_UID, 'member', 'invited');

    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('soft-deleted user is denied despite an active membership', async () => {
    // The property we deliberately paid one document read to keep: an
    // admin-disabled user loses access immediately, while still holding a live
    // session token and before any cascade removes their member rows.
    const db = await asUser(DELETED_UID, 'member', [SITE_A]);
    await seedAsAdmin(async (adminDb) => {
      await setDoc(doc(adminDb, 'users', DELETED_UID), {
        uid: DELETED_UID,
        email: `${DELETED_UID}@harness.test`,
        role: 'member',
        sites: [SITE_A],
        deletedAt: Date.now(),
      });
    });

    await assertFails(getDoc(doc(db, 'sites', SITE_A)));
  });

  test('superadmin reaches every site holding no member rows at all', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_B)));
  });
});

describe('per-site roles', () => {
  // `audit_log` read is the one path gated on isSiteAdmin(siteId), so it is what
  // separates a site admin from a plain member at the rules layer.
  const auditEntry = (siteId: string) => ['sites', siteId, 'audit_log', 'entry-1'] as const;

  beforeEach(async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, ...auditEntry(SITE_A)), { action: 'site.update', at: Date.now() });
      await setDoc(doc(db, ...auditEntry(SITE_B)), { action: 'site.update', at: Date.now() });
    });
  });

  test('per-site admin passes isSiteAdmin', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertSucceeds(getDoc(doc(db, ...auditEntry(SITE_A))));
  });

  test('owner outranks admin and passes isSiteAdmin', async () => {
    const db = await asUser(OWNER_UID, 'member', [SITE_A], { [SITE_A]: 'owner' });

    await assertSucceeds(getDoc(doc(db, ...auditEntry(SITE_A))));
  });

  test('plain member does not pass isSiteAdmin', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    // Access to the site itself, but not to the admin-only path within it.
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A)));
    await assertFails(getDoc(doc(db, ...auditEntry(SITE_A))));
  });

  test('per-site admin on A is only a member on B', async () => {
    // The point of per-site roles: one user, two standings.
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A, SITE_B], { [SITE_B]: 'member' });

    await assertSucceeds(getDoc(doc(db, ...auditEntry(SITE_A))));
    await assertSucceeds(getDoc(doc(db, 'sites', SITE_B)));
    await assertFails(getDoc(doc(db, ...auditEntry(SITE_B))));
  });
});

describe('webhook documents are not member-readable', () => {
  // They can still carry a legacy in-document signing secret — webhookSender
  // falls back to one, and dev holds two such documents — so a member read is a
  // key disclosure that survives removal from the site.
  beforeEach(async () => {
    await seedAsAdmin(async (db) => {
      await setDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-1'), {
        url: 'https://hooks.example.com/x',
        events: ['process.crashed'],
        signingSecret: 'legacy-in-document-secret',
      });
    });
  });

  test('a plain member cannot read a webhook document', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(getDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-1')));
  });

  test('a site admin can', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-1')));
  });

  test('an owner can', async () => {
    const db = await asUser(OWNER_UID, 'member', [SITE_A], { [SITE_A]: 'owner' });

    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-1')));
  });

  test('nobody may write one from the client', async () => {
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'webhooks', 'wh-2'), { url: 'https://evil.example' }),
    );
  });
});

describe('member documents: the collectionGroup read path', () => {
  test('a user can query their own memberships across sites', async () => {
    // The Wave 4.2 listener. It is legal only because the recursive
    // `match /{path=**}/members/{memberUid}` block exists — a rule nested under
    // `match /sites/{siteId}` would not authorize a collectionGroup query.
    const db = await asUser(MEMBER_UID, 'member', [SITE_A, SITE_B]);

    const snap = await assertSucceeds(
      getDocs(query(collectionGroup(db, 'members'), where('uid', '==', MEMBER_UID))),
    );
    expect(snap.docs.map((d) => d.ref.parent.parent?.id).sort()).toEqual([SITE_A, SITE_B]);
  });

  test('the query cannot be widened to another user', async () => {
    await asUser(OTHER_UID, 'member', [SITE_A]);
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      getDocs(query(collectionGroup(db, 'members'), where('uid', '==', OTHER_UID))),
    );
  });

  test('an unfiltered collectionGroup query is refused', async () => {
    // Nothing proves the rule for an unconstrained query, so it must fail — this
    // is the 1756e5f regression restated as a test.
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(getDocs(collectionGroup(db, 'members')));
  });

  test('a user can read their own member document but not another user\'s', async () => {
    await asUser(OTHER_UID, 'member', [SITE_A]);
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertSucceeds(getDoc(doc(db, 'sites', SITE_A, 'members', MEMBER_UID)));
    await assertFails(getDoc(doc(db, 'sites', SITE_A, 'members', OTHER_UID)));
  });
});

describe('member documents are server-written only', () => {
  test('a site admin cannot grant themselves ownership', async () => {
    // membership.server.ts is the single writer, and the escalation it closes is
    // exactly this: an admin overwriting the owner row to take the site.
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'members', ADMIN_UID), {
        uid: ADMIN_UID,
        role: 'owner',
        status: 'active',
        addedAt: new Date(),
        addedBy: ADMIN_UID,
      }),
    );
  });

  test('a member cannot add another user to a site', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'members', OTHER_UID), {
        uid: OTHER_UID,
        role: 'member',
        status: 'active',
        addedAt: new Date(),
        addedBy: MEMBER_UID,
      }),
    );
  });

  test('a member cannot delete their own membership row', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(deleteDoc(doc(db, 'sites', SITE_A, 'members', MEMBER_UID)));
  });

  // the update path, which nothing else pins: a swoop mode is set only through
  // the members API, which refuses your own row and needs SITE_MEMBER_MANAGE
  test('a member cannot give themselves swoop control', async () => {
    const db = await asUser(MEMBER_UID, 'member', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'members', MEMBER_UID), { swoop: 'control' }),
    );
  });

  test("a site admin cannot set another member's swoop from the client", async () => {
    await asUser(OTHER_UID, 'member', [SITE_A]);
    const db = await asUser(ADMIN_UID, 'admin', [SITE_A]);

    await assertFails(
      updateDoc(doc(db, 'sites', SITE_A, 'members', OTHER_UID), { swoop: 'control' }),
    );
  });

  test('even a superadmin cannot write member rows from the client', async () => {
    const db = await asUser(SUPER_UID, 'superadmin', []);

    await assertFails(
      setDoc(doc(db, 'sites', SITE_A, 'members', SUPER_UID), {
        uid: SUPER_UID,
        role: 'owner',
        status: 'active',
        addedAt: new Date(),
        addedBy: SUPER_UID,
      }),
    );
  });
});
