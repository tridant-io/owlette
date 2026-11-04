/** @jest-environment node */

/**
 * GET /api/sites/{siteId}/member-candidates. the wrapper is replaced by one that
 * hands the handler `mockCtx`, whose actor is built from the target site's row
 * the way the real wrapper builds it, so these cases reach the handler's own
 * checks. the real wrapper runs in membershipEscalation.test.ts block 13.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

type Row = Record<string, unknown>;

/** what the wrapper hands the handler, set per case by `sessionAs` or `keyAs`. */
let mockCtx: { actor: Row; auth: { userId: string; keyContext: Row | null } };

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedSiteHandler:
    () =>
    (handler: (...args: unknown[]) => unknown) =>
    async (
      request: unknown,
      routeContext: { params: Promise<{ siteId: string }> },
    ) => {
      const params = await routeContext.params;
      return handler(
        request,
        {
          actor: mockCtx.actor,
          siteId: params.siteId,
          correlationId: 'corr-test',
          auth: mockCtx.auth,
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      );
    },
}));

const mockListUserStanding = jest.fn();
jest.mock('@/lib/sitePolicy.server', () => ({
  ...jest.requireActual('@/lib/sitePolicy.server'),
  listUserStanding: (...a: unknown[]) => mockListUserStanding(...a),
}));

// the shared firestore mock has no select(), so this double holds member rows by
// site then uid, and `users/{uid}` documents.
const mockRosters: Record<string, Record<string, Row>> = {};
const mockUsers: Record<string, Row> = {};
/** every read the route makes, so a refusal can show it made none. */
const mockReads = jest.fn();
/** the number of refs in each `getAll`. */
const mockGetAllSizes = jest.fn();

function mockSnap(id: string, data: Row | undefined) {
  return { id, exists: data !== undefined, data: () => data };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name === 'sites') {
        return {
          doc: (siteId: string) => ({
            collection: (sub: string) => {
              if (sub !== 'members') throw new Error(`unexpected subcollection ${sub}`);
              return {
                get: async () => {
                  mockReads(`sites/${siteId}/members`);
                  return {
                    docs: Object.entries(mockRosters[siteId] ?? {}).map(([uid, row]) =>
                      mockSnap(uid, row),
                    ),
                  };
                },
              };
            },
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: (uid: string) => ({ id: uid, get: async () => mockSnap(uid, mockUsers[uid]) }),
          // a projection, as the real select() returns only the fields it names
          select: (...fields: string[]) => ({
            get: async () => {
              mockReads('users.select');
              return {
                docs: Object.entries(mockUsers).map(([uid, data]) =>
                  mockSnap(
                    uid,
                    Object.fromEntries(fields.filter((f) => f in data).map((f) => [f, data[f]])),
                  ),
                ),
              };
            },
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) => {
      mockReads('getAll');
      mockGetAllSizes(refs.length);
      return Promise.all(refs.map((ref) => ref.get()));
    },
  }),
}));

// imports come after the mocks

import { GET } from '@/app/api/sites/[siteId]/member-candidates/route';
import { siteStanding, type MemberStanding, type SiteRole } from '@/lib/capabilities';
import { deriveMembership, deriveSwoopMode } from '@/lib/sitePolicy.server';

const TARGET = 'site-a';
const SELF = 'uid-self';

type Body = { code?: string; candidates: Row[] };

function seedRow(siteId: string, uid: string, role: string, extra: Row = {}): void {
  mockRosters[siteId] = {
    ...mockRosters[siteId],
    [uid]: { uid, role, status: 'active', ...extra },
  };
}

function seedUser(uid: string, data: Row = {}): void {
  mockUsers[uid] = { email: `${uid}@example.test`, role: 'member', ...data };
}

/** what `listUserStanding` reads off the seeded rows, through the real row readers. */
function standingOf(uid: string): Record<string, MemberStanding & { role: SiteRole }> {
  const bySite: Record<string, MemberStanding & { role: SiteRole }> = Object.create(null);
  for (const [siteId, roster] of Object.entries(mockRosters)) {
    const row = roster[uid] ?? null;
    const role = deriveMembership(row);
    if (role !== null) bySite[siteId] = { role, swoopMode: deriveSwoopMode(row, role) };
  }
  return bySite;
}

/** a session whose actor is built from the target site's row, as the wrapper builds it. */
function sessionAs(uid: string, globalRole: 'member' | 'superadmin' = 'member'): void {
  const onTarget = standingOf(uid)[TARGET] ?? { role: null, swoopMode: null };
  mockCtx = {
    actor: { type: 'user', userId: uid, role: globalRole, ...siteStanding({ [TARGET]: onTarget }) },
    auth: { userId: uid, keyContext: null },
  };
}

function keyAs(uid: string): void {
  sessionAs(uid);
  mockCtx = {
    actor: { ...mockCtx.actor, apiKeyId: 'key_test' },
    auth: {
      userId: uid,
      keyContext: {
        keyId: 'key_test',
        environment: 'live',
        isLegacy: false,
        scopes: [{ resource: 'site', id: '*', permissions: ['read', 'admin'] }],
        expiresAt: null,
      },
    },
  };
}

async function list(): Promise<{ status: number; body: Body }> {
  const res = await GET(
    createMockRequest(`http://localhost/api/sites/${TARGET}/member-candidates`),
    { params: Promise.resolve({ siteId: TARGET }) },
  );
  return { status: res.status, body: await res.json() };
}

function uidsOf(body: Body): unknown[] {
  return body.candidates.map((candidate) => candidate.uid);
}

beforeEach(() => {
  for (const k of Object.keys(mockRosters)) delete mockRosters[k];
  for (const k of Object.keys(mockUsers)) delete mockUsers[k];
  mockListUserStanding.mockImplementation(async (uid: string) => standingOf(uid));
});

describe('GET /api/sites/{siteId}/member-candidates', () => {
  describe('who may ask', () => {
    it('refuses an api key with 403 api_key_not_permitted, before any read', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedUser(SELF);
      keyAs(SELF);

      const { status, body } = await list();

      expect(status).toBe(403);
      expect(body.code).toBe('api_key_not_permitted');
      expect(mockReads).not.toHaveBeenCalled();
      expect(mockListUserStanding).not.toHaveBeenCalled();
    });

    it('refuses a member of the site with 403 site_member_manage_required when the wrapper let them through', async () => {
      // as under the kill switch, which skips the wrapper's own capability
      // check. they administer site-b, so without the handler's check they
      // would be answered with site-b's people.
      seedRow(TARGET, SELF, 'member');
      seedRow('site-b', SELF, 'admin');
      seedRow('site-b', 'uid-y', 'member');
      seedUser(SELF);
      seedUser('uid-y');
      sessionAs(SELF);

      const { status, body } = await list();

      expect(status).toBe(403);
      expect(body).toMatchObject({
        code: 'site_member_manage_required',
        detail: 'listing member candidates requires the SITE_MEMBER_MANAGE capability on this site',
        instance: `/api/sites/${TARGET}/member-candidates`,
      });
      expect(mockReads).not.toHaveBeenCalled();
      expect(mockListUserStanding).not.toHaveBeenCalled();
    });
  });

  describe('a site admin', () => {
    it('is offered the active members of the other sites they administer, and no one else', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedRow(TARGET, 'uid-x', 'member');
      seedRow('site-b', SELF, 'admin');
      seedRow('site-b', 'uid-y', 'member');
      seedRow('site-b', 'uid-z', 'member');
      seedRow('site-b', 'uid-w', 'member', { status: 'invited' });
      seedRow('site-c', SELF, 'member');
      seedRow('site-c', 'uid-q', 'member');
      for (const uid of [SELF, 'uid-x', 'uid-y', 'uid-w', 'uid-q']) seedUser(uid);
      seedUser('uid-z', { deletedAt: 1700000000000 });
      sessionAs(SELF);

      const { status, body } = await list();

      expect(status).toBe(200);
      expect(uidsOf(body)).toEqual(['uid-y']);
      expect(mockListUserStanding).toHaveBeenCalledWith(SELF);
      // site-c is theirs only as a member, so its roster is never read
      expect(mockReads).not.toHaveBeenCalledWith('sites/site-c/members');
    });

    it('is never offered someone already on this site, even from another site they administer', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedRow(TARGET, 'uid-x', 'member');
      seedRow('site-b', SELF, 'owner');
      seedRow('site-b', 'uid-x', 'admin');
      seedRow('site-b', 'uid-y', 'member');
      for (const uid of [SELF, 'uid-x', 'uid-y']) seedUser(uid);
      sessionAs(SELF);

      const { body } = await list();

      expect(uidsOf(body)).toEqual(['uid-y']);
      // this site's people are taken out before any user document is read
      expect(mockGetAllSizes.mock.calls).toEqual([[1]]);
    });

    it('is offered no one when this site is the only one they own', async () => {
      seedRow(TARGET, SELF, 'owner');
      seedRow(TARGET, 'uid-x', 'member');
      seedUser(SELF);
      seedUser('uid-x');
      sessionAs(SELF);

      const { status, body } = await list();

      expect(status).toBe(200);
      expect(body.candidates).toEqual([]);
      // an empty union reads no users: the real getAll() throws with no refs
      expect(mockGetAllSizes).not.toHaveBeenCalled();
    });

    it('still counts a site where they are held to no swoop: the mode changes swoop only', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedRow('site-b', SELF, 'admin', { swoop: 'none' });
      seedRow('site-b', 'uid-y', 'member');
      seedUser(SELF);
      seedUser('uid-y');
      sessionAs(SELF);

      const { body } = await list();

      expect(uidsOf(body)).toEqual(['uid-y']);
    });
  });

  describe('a superadmin', () => {
    it("is offered every account except this site's members, soft-deleted accounts and superadmins", async () => {
      seedRow(TARGET, 'uid-owner', 'owner');
      seedRow(TARGET, 'uid-x', 'member');
      seedUser(SELF, { role: 'superadmin', createdAt: 1 });
      seedUser('uid-owner', { createdAt: 1 });
      seedUser('uid-x', { createdAt: 1 });
      seedUser('uid-y', { createdAt: 1 });
      // a legacy document with no createdAt, which an orderBy would drop
      seedUser('uid-legacy');
      seedUser('uid-gone', { createdAt: 1, deletedAt: 1700000000000 });
      seedUser('uid-other-super', { role: 'superadmin', createdAt: 1 });
      sessionAs(SELF, 'superadmin');

      const { status, body } = await list();

      expect(status).toBe(200);
      expect(uidsOf(body)).toEqual(['uid-legacy', 'uid-y']);
      expect(mockReads).toHaveBeenCalledWith('users.select');
      // superadmins hold no rows, so there is no standing to list
      expect(mockListUserStanding).not.toHaveBeenCalled();
    });
  });

  describe('the answer', () => {
    it('carries exactly uid, email and displayName, never a role, a swoop mode or a site', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedRow('site-b', SELF, 'admin');
      seedRow('site-b', 'uid-y', 'admin', { swoop: 'control' });
      seedRow('site-b', 'uid-v', 'member');
      seedUser(SELF);
      seedUser('uid-y', {
        displayName: 'Yara',
        role: 'admin',
        sites: ['site-b', 'site-secret'],
        createdAt: 1,
      });
      // no email and no name: both answer null
      mockUsers['uid-v'] = { role: 'member' };
      sessionAs(SELF);

      const { body } = await list();

      expect(body.candidates).toEqual([
        { uid: 'uid-v', email: null, displayName: null },
        { uid: 'uid-y', email: 'uid-y@example.test', displayName: 'Yara' },
      ]);
      for (const candidate of body.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(['displayName', 'email', 'uid']);
      }
      expect(JSON.stringify(body)).not.toContain('site-secret');
    });

    it('sorts case-insensitively by name, else email, else uid', async () => {
      seedUser(SELF, { role: 'superadmin' });
      seedUser('uid-1', { displayName: 'bravo', email: 'zulu@example.test' });
      seedUser('uid-2', { displayName: 'Alpha', email: 'yankee@example.test' });
      seedUser('uid-3', { email: 'Charlie@example.test' });
      seedUser('uid-4', { displayName: 'delta', email: 'able@example.test' });
      mockUsers['echo-uid'] = { role: 'member' };
      sessionAs(SELF, 'superadmin');

      const { body } = await list();

      expect(uidsOf(body)).toEqual(['uid-2', 'uid-1', 'uid-3', 'uid-4', 'echo-uid']);
    });

    it('reads 250 people in getAll calls of at most 100', async () => {
      seedRow(TARGET, SELF, 'admin');
      seedRow('site-b', SELF, 'admin');
      seedUser(SELF);
      for (let i = 0; i < 250; i += 1) {
        const uid = `uid-${String(i).padStart(3, '0')}`;
        seedRow('site-b', uid, 'member');
        seedUser(uid);
      }
      sessionAs(SELF);

      const { body } = await list();

      expect(body.candidates).toHaveLength(250);
      const sizes = mockGetAllSizes.mock.calls.map(([size]) => size as number);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(250);
    });
  });
});
