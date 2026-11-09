/** @jest-environment node */

/**
 * The picker's eligibility rule has to agree with the server's, or the UI
 * offers successors the reassign API will refuse. These tests pin the four
 * cases the capability matrix decides, plus the ordering the picker relies on.
 *
 * The authoritative check lives in `reassignTalons` and is covered in
 * `__tests__/lib/talons/store.test.ts`; this is the mirror.
 */

import { eligibleTalonSuccessors, siteTalonSuccessors } from '@/lib/talonSuccessors';

const SITE = 'site-a';

const USERS = [
  { uid: 'zoe-admin', email: 'zoe@example.com', role: 'admin', sites: [SITE] },
  { uid: 'amy-admin', email: 'amy@example.com', role: 'admin', sites: [SITE] },
  { uid: 'other-admin', email: 'other@example.com', role: 'admin', sites: ['site-b'] },
  { uid: 'root', email: 'root@example.com', role: 'superadmin', sites: [] },
  { uid: 'mem', email: 'mem@example.com', role: 'member', sites: [SITE] },
  {
    uid: 'gone',
    email: 'gone@example.com',
    role: 'admin',
    sites: [SITE],
    deletedAt: 1_700_000_000_000,
  },
];

describe('eligibleTalonSuccessors', () => {
  it('offers site admins and superadmins, in label order', () => {
    expect(eligibleTalonSuccessors(USERS, { siteId: SITE })).toEqual([
      { uid: 'amy-admin', label: 'amy@example.com' },
      { uid: 'root', label: 'root@example.com' },
      { uid: 'zoe-admin', label: 'zoe@example.com' },
    ]);
  });

  it('excludes an admin scoped to a different site — TALON_MANAGE is site-scoped', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('other-admin');
  });

  it('excludes members — they could not have authored the talon either', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('mem');
  });

  it('excludes soft-deleted accounts — the exact failure this feature prevents', () => {
    const uids = eligibleTalonSuccessors(USERS, { siteId: SITE }).map((c) => c.uid);
    expect(uids).not.toContain('gone');
  });

  it('never offers the departing user as their own successor', () => {
    const uids = eligibleTalonSuccessors(USERS, {
      siteId: SITE,
      excludeUid: 'zoe-admin',
    }).map((c) => c.uid);
    expect(uids).not.toContain('zoe-admin');
  });

  it('keeps every admin when no site is named — the fleet-wide delete flow', () => {
    // Per-site eligibility is re-checked server-side once per site; hiding
    // admins here would under-offer for the sites they DO cover.
    const uids = eligibleTalonSuccessors(USERS).map((c) => c.uid);
    expect(uids).toEqual(['amy-admin', 'other-admin', 'root', 'zoe-admin']);
  });

  it('falls back to display name, then uid, when there is no email', () => {
    expect(
      eligibleTalonSuccessors([
        { uid: 'u1', displayName: 'Ada', role: 'admin', sites: [SITE] },
        { uid: 'u2', role: 'admin', sites: [SITE] },
      ], { siteId: SITE }),
    ).toEqual([
      { uid: 'u1', label: 'Ada' },
      { uid: 'u2', label: 'u2' },
    ]);
  });
});

describe('siteTalonSuccessors', () => {
  // shaped like the rows GET /api/sites/{siteId}/members returns: `role` is the
  // site role from the member row, `globalRole` the account's own
  const MEMBERS = [
    { uid: 'zoe-owner', email: 'zoe@example.com', displayName: null, role: 'owner', globalRole: 'member' },
    { uid: 'bea-admin', email: 'Bea@example.com', displayName: null, role: 'admin', globalRole: 'member' },
    { uid: 'amy-admin', email: 'amy@example.com', displayName: null, role: 'admin', globalRole: 'admin' },
    { uid: 'mem', email: 'mem@example.com', displayName: null, role: 'member', globalRole: 'admin' },
  ];

  it("offers the site's owners and admins, in label order, ignoring case", () => {
    expect(siteTalonSuccessors(MEMBERS)).toEqual([
      { uid: 'amy-admin', label: 'amy@example.com' },
      { uid: 'bea-admin', label: 'Bea@example.com' },
      { uid: 'zoe-owner', label: 'zoe@example.com' },
    ]);
  });

  it('reads the site role on the row, not the global role', () => {
    const uids = siteTalonSuccessors(MEMBERS).map((c) => c.uid);
    expect(uids).not.toContain('mem');
    expect(uids).toContain('bea-admin');
  });

  it('never offers the departing member as their own successor', () => {
    const uids = siteTalonSuccessors(MEMBERS, 'zoe-owner').map((c) => c.uid);
    expect(uids).toEqual(['amy-admin', 'bea-admin']);
  });

  it('falls back to display name, then uid, when there is no email', () => {
    expect(
      siteTalonSuccessors([
        { uid: 'u1', email: null, displayName: 'Ada', role: 'admin' },
        { uid: 'u2', email: null, displayName: null, role: 'owner' },
      ]),
    ).toEqual([
      { uid: 'u1', label: 'Ada' },
      { uid: 'u2', label: 'u2' },
    ]);
  });

  it('drops a scoped admin, even one scoped to no machines, and keeps whole-site owners and admins', () => {
    // the server refuses a scoped successor `insufficient_role`: TALON_MANAGE is site-wide
    const uids = siteTalonSuccessors([
      ...MEMBERS,
      { uid: 'scoped-admin', email: 'scoped@example.com', displayName: null, role: 'admin', machineIds: ['m1'] },
      { uid: 'empty-admin', email: 'empty@example.com', displayName: null, role: 'admin', machineIds: [] },
      { uid: 'whole-admin', email: 'whole@example.com', displayName: null, role: 'admin', machineIds: null },
    ]).map((c) => c.uid);
    expect(uids).toEqual(['amy-admin', 'bea-admin', 'whole-admin', 'zoe-owner']);
  });
});
