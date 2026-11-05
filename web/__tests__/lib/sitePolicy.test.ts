/** @jest-environment node */

/**
 * `deriveSwoopMode`, `listUserStanding` and the `swoopMode` fact in
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
  deriveMembership,
  deriveSwoopMode,
  listUserStanding,
  resolveSiteAccess,
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

describe('listUserStanding', () => {
  it("queries the user's member rows across every site", async () => {
    await listUserStanding(UID);
    expect(mockCollectionGroup).toHaveBeenCalledWith('members');
    expect(mockWhere).toHaveBeenCalledWith('uid', '==', UID);
  });

  it('maps each active row to its role and swoop mode, and skips inactive rows and unknown roles', async () => {
    mockMemberDocs = [
      ...ROWS.filter(([siteId]) => siteId !== '__proto__').map(([siteId, row]) => memberDoc(siteId, row)),
      { ref: { parent: { parent: null } }, data: () => ({ uid: UID, role: 'admin', status: 'active' }) },
    ];

    expect(await listUserStanding(UID)).toEqual({
      'site-member': { role: 'member', swoopMode: null },
      'site-member-control': { role: 'member', swoopMode: 'control' },
      'site-member-none': { role: 'member', swoopMode: 'none' },
      'site-admin': { role: 'admin', swoopMode: null },
      'site-admin-view': { role: 'admin', swoopMode: 'view' },
      'site-admin-malformed': { role: 'admin', swoopMode: 'none' },
      'site-admin-null': { role: 'admin', swoopMode: 'none' },
      'site-owner': { role: 'owner', swoopMode: null },
    });
  });

  it('returns a site id __proto__ as an own key', async () => {
    mockMemberDocs = [memberDoc('__proto__', { uid: UID, role: 'member', status: 'active', swoop: 'view' })];

    const standing = await listUserStanding(UID);

    expect(Object.keys(standing)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(standing, '__proto__')?.value).toEqual({
      role: 'member',
      swoopMode: 'view',
    });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('reads every row exactly as access does', async () => {
    const standing = await listUserStanding(UID);

    for (const [siteId, row] of ROWS) {
      const role = deriveMembership(row);
      if (role === null) {
        expect(own(standing, siteId)).toBeUndefined();
      } else {
        expect(own(standing, siteId)).toEqual({ role, swoopMode: deriveSwoopMode(row, role) });
      }
    }
  });
});

describe('resolveSiteAccess', () => {
  /** the one `getAll` access makes: the site, the user, and `memberRow` as the member document. */
  function fakeDb(memberRow: Record<string, unknown> | null): FirebaseFirestore.Firestore {
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
      getAll: async (...refs: Array<{ path: string }>) =>
        refs.map((ref) => {
          if (ref.path.includes('/members/')) return snap(memberRow);
          if (ref.path.startsWith('users/')) return snap({ role: 'member' });
          return snap({ name: 'a site' });
        }),
    } as unknown as FirebaseFirestore.Firestore;
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
});
