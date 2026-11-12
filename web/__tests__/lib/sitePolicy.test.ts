/** @jest-environment node */

/**
 * `deriveSwoopMode`, `deriveMachineIds`, `memberStanding`, `standingOf`,
 * `listUserStanding` and the `swoopMode` and `machineIds` facts in
 * `web/lib/sitePolicy.server.ts`. A member row has one reading, whether access
 * reads it for the one site a request names or a listing reads it for every
 * site the user is on.
 */

type MockMemberDoc = {
  ref: { parent: { parent: { id: string } | null } };
  data: () => Record<string, unknown>;
};

const mockCollectionGroup = jest.fn();
const mockWhere = jest.fn();
let mockMemberDocs: MockMemberDoc[] = [];

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(),
  getAdminDb: () => ({
    collectionGroup: (name: string) => {
      mockCollectionGroup(name);
      return {
        where: (field: string, op: string, value: unknown) => {
          mockWhere(field, op, value);
          return { get: async () => ({ docs: mockMemberDocs }) };
        },
      };
    },
  }),
}));

import {
  deriveMachineIds,
  deriveMembership,
  deriveSwoopMode,
  listUserStanding,
  memberStanding,
  resolveSiteAccess,
  standingOf,
  type SiteAccessFacts,
} from '@/lib/sitePolicy.server';

const UID = 'uid-alice';

/** [site id, member row]: every shape a row can take, `__proto__` included. */
const ROWS: Array<[string, Record<string, unknown>]> = [
  ['site-member', { uid: UID, role: 'member', status: 'active' }],
  ['site-member-control', { uid: UID, role: 'member', status: 'active', swoop: 'control' }],
  ['site-member-none', { uid: UID, role: 'member', status: 'active', swoop: 'none' }],
  ['site-admin', { uid: UID, role: 'admin', status: 'active' }],
  ['site-admin-view', { uid: UID, role: 'admin', status: 'active', swoop: 'view' }],
  ['site-admin-malformed', { uid: UID, role: 'admin', status: 'active', swoop: 'Control' }],
  ['site-admin-null', { uid: UID, role: 'admin', status: 'active', swoop: null }],
  ['site-owner', { uid: UID, role: 'owner', status: 'active', swoop: 'none' }],
  ['site-invited', { uid: UID, role: 'admin', status: 'invited', swoop: 'control' }],
  ['site-no-status', { uid: UID, role: 'member', swoop: 'view' }],
  ['site-unknown-role', { uid: UID, role: 'superadmin', status: 'active', swoop: 'control' }],
  ['site-member-scoped', { uid: UID, role: 'member', status: 'active', swoop: 'control', machineIds: ['m2', 'm1'] }],
  ['site-admin-scope-malformed', { uid: UID, role: 'admin', status: 'active', machineIds: 'm1' }],
  ['site-owner-scoped', { uid: UID, role: 'owner', status: 'active', machineIds: ['m1'] }],
  ['site-invited-scoped', { uid: UID, role: 'admin', status: 'invited', machineIds: ['m1'] }],
  ['__proto__', { uid: UID, role: 'member', status: 'active', swoop: 'view' }],
];

function memberDoc(siteId: string, row: Record<string, unknown>): MockMemberDoc {
  return { ref: { parent: { parent: { id: siteId } } }, data: () => row };
}

function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

beforeEach(() => {
  mockMemberDocs = ROWS.map(([siteId, row]) => memberDoc(siteId, row));
});

describe('deriveSwoopMode', () => {
  it('is null for an owner row, an inactive row and a row with no role', () => {
    const owner = { role: 'owner', status: 'active', swoop: 'none' };
    expect(deriveSwoopMode(owner, deriveMembership(owner))).toBeNull();

    const invited = { role: 'admin', status: 'invited', swoop: 'control' };
    expect(deriveSwoopMode(invited, deriveMembership(invited))).toBeNull();

    const unknownRole = { role: 'superadmin', status: 'active', swoop: 'control' };
    expect(deriveSwoopMode(unknownRole, deriveMembership(unknownRole))).toBeNull();
    expect(deriveSwoopMode(null, null)).toBeNull();
  });

  it('parses the field on an admin or a member row', () => {
    for (const role of ['admin', 'member'] as const) {
      expect(deriveSwoopMode({ role, status: 'active' }, role)).toBeNull();
      expect(deriveSwoopMode({ role, status: 'active', swoop: 'none' }, role)).toBe('none');
      expect(deriveSwoopMode({ role, status: 'active', swoop: 'view' }, role)).toBe('view');
      expect(deriveSwoopMode({ role, status: 'active', swoop: 'control' }, role)).toBe('control');
      expect(deriveSwoopMode({ role, status: 'active', swoop: 'Control' }, role)).toBe('none');
      expect(deriveSwoopMode({ role, status: 'active', swoop: null }, role)).toBe('none');
    }
  });
});

describe('deriveMachineIds', () => {
  it('is null for a row that grants nothing, whatever it carries', () => {
    expect(deriveMachineIds(null, null)).toBeNull();
    const invited = { role: 'admin', status: 'invited', machineIds: ['m1'] };
    expect(deriveMachineIds(invited, deriveMembership(invited))).toBeNull();
  });

  it('is null with no field: the whole site', () => {
    expect(deriveMachineIds({ role: 'member', status: 'active' }, 'member')).toBeNull();
  });

  it('reads a list sorted, and a malformed value as no machines', () => {
    expect(deriveMachineIds({ role: 'member', status: 'active', machineIds: ['m2', 'm1'] }, 'member')).toEqual([
      'm1',
      'm2',
    ]);
    for (const malformed of ['m1', null, { m1: true }, 3]) {
      expect(deriveMachineIds({ role: 'admin', status: 'active', machineIds: malformed }, 'admin')).toEqual([]);
    }
  });

  it('reads an owner row too, because the rules do', () => {
    expect(deriveMachineIds({ role: 'owner', status: 'active', machineIds: ['m1'] }, 'owner')).toEqual(['m1']);
  });
});

describe('memberStanding', () => {
  it('is the three derive functions on every row', () => {
    for (const [, row] of ROWS) {
      const role = deriveMembership(row);
      expect(memberStanding(row)).toEqual({
        role,
        swoopMode: deriveSwoopMode(row, role),
        machineIds: deriveMachineIds(row, role),
      });
    }
    expect(memberStanding(null)).toEqual({ role: null, swoopMode: null, machineIds: null });
  });
});

describe('standingOf', () => {
  it('copies the role, the mode and the machine scope out of the facts', () => {
    const facts = {
      membershipRole: 'admin',
      swoopMode: 'view',
      machineIds: ['m1'],
      globalRole: 'superadmin',
      siteId: 'site-a',
    } as unknown as SiteAccessFacts;
    expect(standingOf(facts)).toEqual({ role: 'admin', swoopMode: 'view', machineIds: ['m1'] });
  });
});

describe('listUserStanding', () => {
  it("queries the user's member rows across every site", async () => {
    await listUserStanding(UID);
    expect(mockCollectionGroup).toHaveBeenCalledWith('members');
    expect(mockWhere).toHaveBeenCalledWith('uid', '==', UID);
  });

  it('maps each active row to its standing, and skips inactive rows and unknown roles', async () => {
    mockMemberDocs = [
      ...ROWS.filter(([siteId]) => siteId !== '__proto__').map(([siteId, row]) => memberDoc(siteId, row)),
      { ref: { parent: { parent: null } }, data: () => ({ uid: UID, role: 'admin', status: 'active' }) },
    ];

    expect(await listUserStanding(UID)).toEqual({
      'site-member': { role: 'member', swoopMode: null, machineIds: null },
      'site-member-control': { role: 'member', swoopMode: 'control', machineIds: null },
      'site-member-none': { role: 'member', swoopMode: 'none', machineIds: null },
      'site-admin': { role: 'admin', swoopMode: null, machineIds: null },
      'site-admin-view': { role: 'admin', swoopMode: 'view', machineIds: null },
      'site-admin-malformed': { role: 'admin', swoopMode: 'none', machineIds: null },
      'site-admin-null': { role: 'admin', swoopMode: 'none', machineIds: null },
      'site-owner': { role: 'owner', swoopMode: null, machineIds: null },
      'site-member-scoped': { role: 'member', swoopMode: 'control', machineIds: ['m1', 'm2'] },
      'site-admin-scope-malformed': { role: 'admin', swoopMode: null, machineIds: [] },
      'site-owner-scoped': { role: 'owner', swoopMode: null, machineIds: ['m1'] },
    });
  });

  it('returns a site id __proto__ as an own key', async () => {
    mockMemberDocs = [memberDoc('__proto__', { uid: UID, role: 'member', status: 'active', swoop: 'view' })];

    const standing = await listUserStanding(UID);

    expect(Object.keys(standing)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(standing, '__proto__')?.value).toEqual({
      role: 'member',
      swoopMode: 'view',
      machineIds: null,
    });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('reads every row exactly as memberStanding does', async () => {
    const standing = await listUserStanding(UID);

    for (const [siteId, row] of ROWS) {
      if (deriveMembership(row) === null) {
        expect(own(standing, siteId)).toBeUndefined();
      } else {
        expect(own(standing, siteId)).toEqual(memberStanding(row));
      }
    }
  });
});

describe('resolveSiteAccess', () => {
  /** the one `getAll` access makes: the site, `userRow` as the user, and `memberRow` as the member document. */
  function fakeDb(
    memberRow: Record<string, unknown> | null,
    userRow: Record<string, unknown> = { role: 'member' },
  ): FirebaseFirestore.Firestore & { getAll: jest.Mock } {
    const snap = (data: Record<string, unknown> | null) => ({
      exists: data !== null,
      data: () => data ?? undefined,
    });
    const docRef = (path: string): unknown => ({
      path,
      collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
    });
    return {
      collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
      getAll: jest.fn(async (...refs: Array<{ path: string }>) =>
        refs.map((ref) => {
          if (ref.path.includes('/members/')) return snap(memberRow);
          if (ref.path.startsWith('users/')) return snap(userRow);
          return snap({ name: 'a site' });
        }),
      ),
    } as unknown as FirebaseFirestore.Firestore & { getAll: jest.Mock };
  }

  it('puts the same swoop mode in facts as the listing reads off the same row', async () => {
    const standing = await listUserStanding(UID);

    for (const [siteId, row] of ROWS) {
      const outcome = await resolveSiteAccess(UID, siteId, fakeDb(row));
      expect(outcome.facts.membershipRole).toBe(own(standing, siteId)?.role ?? null);
      expect(outcome.facts.swoopMode).toBe(own(standing, siteId)?.swoopMode ?? null);
      expect(outcome.facts.swoopMode).toBe(deriveSwoopMode(row, deriveMembership(row)));
    }
  });

  it('has no swoop mode with no member row', async () => {
    const outcome = await resolveSiteAccess(UID, 'site-member', fakeDb(null));
    expect(outcome).toMatchObject({ ok: false, reason: 'no_access' });
    expect(outcome.facts.swoopMode).toBeNull();
  });

  it.each<[string, Record<string, unknown> | null, Record<string, unknown>, readonly string[] | null]>([
    ['no field', { uid: UID, role: 'member', status: 'active' }, { role: 'member' }, null],
    ['a list', { uid: UID, role: 'admin', status: 'active', machineIds: ['m2', 'm1'] }, { role: 'member' }, ['m1', 'm2']],
    ['a malformed value', { uid: UID, role: 'admin', status: 'active', machineIds: 'm1' }, { role: 'member' }, []],
    ['a superadmin with a scoped row', { uid: UID, role: 'member', status: 'active', machineIds: ['m1'] }, { role: 'superadmin' }, null],
    ['an inactive row', { uid: UID, role: 'admin', status: 'invited', machineIds: ['m1'] }, { role: 'member' }, null],
    ['no member row', null, { role: 'member' }, null],
  ])('puts the machine scope in facts: %s', async (_name, memberRow, userRow, expected) => {
    const db = fakeDb(memberRow, userRow);
    const outcome = await resolveSiteAccess(UID, 'site-a', db);

    expect(outcome.facts.machineIds).toEqual(expected);
    // the scope rides the one read access already makes
    expect(db.getAll).toHaveBeenCalledTimes(1);
    expect(db.getAll.mock.calls[0]).toHaveLength(3);
  });

  it('puts the same machine scope in facts as memberStanding reads off the same row', async () => {
    for (const [siteId, row] of ROWS) {
      const outcome = await resolveSiteAccess(UID, siteId, fakeDb(row));
      expect(outcome.facts.machineIds).toEqual(memberStanding(row).machineIds);
      expect(standingOf(outcome.facts)).toEqual(memberStanding(row));
    }
  });
});
