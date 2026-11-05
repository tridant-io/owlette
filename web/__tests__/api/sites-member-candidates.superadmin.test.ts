/** @jest-environment node */

/**
 * GET /api/sites/{siteId}/member-candidates leaves superadmin accounts out of a
 * site admin's list, not only out of a superadmin's: an account made a
 * superadmin keeps the member rows it already held. the doubles are those of
 * sites-member-candidates.test.ts, cut to what the site admin's path reads.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

type Row = Record<string, unknown>;

/** what the wrapper hands the handler. */
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

// member rows by site then uid, and `users/{uid}` documents
const mockRosters: Record<string, Record<string, Row>> = {};
const mockUsers: Record<string, Row> = {};

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
                get: async () => ({
                  docs: Object.entries(mockRosters[siteId] ?? {}).map(([uid, row]) =>
                    mockSnap(uid, row),
                  ),
                }),
              };
            },
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: (uid: string) => ({ id: uid, get: async () => mockSnap(uid, mockUsers[uid]) }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    getAll: async (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((ref) => ref.get())),
  }),
}));

// imports come after the mocks

import { GET } from '@/app/api/sites/[siteId]/member-candidates/route';
import { siteStanding, type MemberStanding, type SiteRole } from '@/lib/capabilities';
import { deriveMembership, deriveSwoopMode } from '@/lib/sitePolicy.server';

const TARGET = 'site-a';
const SELF = 'uid-self';
const SUPERADMIN = 'uid-super';

function seedRow(siteId: string, uid: string, role: string): void {
  mockRosters[siteId] = {
    ...mockRosters[siteId],
    [uid]: { uid, role, status: 'active' },
  };
}

function seedUser(uid: string, role: 'member' | 'superadmin' = 'member'): void {
  mockUsers[uid] = { email: `${uid}@example.test`, role };
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

describe('GET /api/sites/{siteId}/member-candidates and superadmin accounts', () => {
  it("never offers a site admin a superadmin account from another site's roster", async () => {
    seedRow(TARGET, SELF, 'admin');
    seedRow('site-b', SELF, 'admin');
    seedRow('site-b', 'uid-y', 'member');
    seedRow('site-b', SUPERADMIN, 'member');
    seedUser(SELF);
    seedUser('uid-y');
    seedUser(SUPERADMIN, 'superadmin');
    mockListUserStanding.mockImplementation(async (uid: string) => standingOf(uid));
    // built from the target site's row, as the wrapper builds it
    mockCtx = {
      actor: { type: 'user', userId: SELF, role: 'member', ...siteStanding([[TARGET, standingOf(SELF)[TARGET]]]) },
      auth: { userId: SELF, keyContext: null },
    };

    const res = await GET(
      createMockRequest(`http://localhost/api/sites/${TARGET}/member-candidates`),
      { params: Promise.resolve({ siteId: TARGET }) },
    );
    const body = (await res.json()) as { candidates: Row[] };
    const uids = body.candidates.map((candidate) => candidate.uid);

    expect(res.status).toBe(200);
    // site-b's roster was read, so the superadmin's absence is the filter's doing
    expect(uids).toContain('uid-y');
    expect(uids).not.toContain(SUPERADMIN);
  });
});
