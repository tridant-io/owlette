/**
 * @jest-environment node
 *
 * Scope-enforcement matrix for the shared helpers used by every roost public
 * api route. Exercises every (resource × permission) combination plus the
 * legacy-key fallback, rotation grace window, and expiration hard-cutoff.
 */
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  scopeFingerprint: jest.fn(() => 'test-fingerprint'),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: jest.fn(() => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('not an id token')),
  })),
  getAdminDb: jest.fn(),
}));

/** Only `resolveAuth` and `assertUserHasSiteAccess` are stubbed; the pure scope
 * logic runs for real. */
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: jest.fn(),
    assertUserHasSiteAccess: jest.fn(),
  };
});

import {
  resolveAuth,
  assertUserHasSiteAccess,
  type ResolvedAuth,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitApiKeyUsed } from '@/lib/auditLogClient';
import {
  requireDistributionManageCapability,
  requireSiteAuthAndScope,
  requireSiteMachineAuthAndScope,
  requireMachineAuthAndScope,
  requireRoostAuthAndScope,
  requireChatAuthAndScope,
  requireAgentOrSiteAuthAndScope,
  requirePlatformAuthAndScope,
  applyAuthDeprecations,
} from '@/app/api/_shared';
import type { ApiKeyPermission, ApiKeyScope } from '@/lib/apiKeyTypes';
import { NextResponse } from 'next/server';

const mockedResolveAuth = resolveAuth as jest.MockedFunction<typeof resolveAuth>;
const mockedAssertSite = assertUserHasSiteAccess as jest.MockedFunction<
  typeof assertUserHasSiteAccess
>;
const mockedAuditEmit = emitApiKeyUsed as jest.MockedFunction<typeof emitApiKeyUsed>;
const mockedGetAdminDb = getAdminDb as jest.MockedFunction<typeof getAdminDb>;

const SITE_ID = 'site-test-01';
const ROOST_ID = 'roost-test-01';
const OTHER_SITE_ID = 'site-test-02';
const OTHER_ROOST_ID = 'roost-test-02';

const ALL_PERMISSIONS: ApiKeyPermission[] = ['read', 'write', 'deploy', 'rollback', 'admin'];

function makeRequest(opts: { method?: string; url?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(new URL(opts.url ?? 'http://localhost/api/test'), {
    headers: opts.headers,
    method: opts.method ?? 'POST',
  });
}

function authFromScopes(scopes: ApiKeyScope[] | null): ResolvedAuth {
  return {
    userId: 'user-test',
    keyContext: {
      keyId: 'key-test',
      scopes,
      environment: 'live',
      expiresAt: Date.now() + 60_000,
      isLegacy: scopes === null,
    },
  };
}

function sessionAuth(): ResolvedAuth {
  return { userId: 'user-test', keyContext: null };
}

type PlatformUserData = {
  role?: 'superadmin' | 'admin' | 'member';
  sites?: string[];
  deletedAt?: number;
};

type SiteData = Record<string, unknown>;

function mockFirestoreDocs(
  opts: {
    user?: PlatformUserData | null;
    site?: SiteData | null;
    /** Per-site standing. Defaults to `admin` so the suite exercises SCOPE
     *  enforcement rather than repeatedly re-proving the capability gate. */
    member?: SiteData | null;
  } = {},
): void {
  const userData: PlatformUserData | null =
    opts.user === undefined ? { role: 'superadmin' } : opts.user;
  const siteData: SiteData | null =
    opts.site === undefined ? { owner: 'site-owner' } : opts.site;
  const memberData: SiteData | null =
    opts.member === undefined
      ? { uid: 'user-1', role: 'admin', status: 'active' }
      : opts.member;

  const snapshot = (data: SiteData | PlatformUserData | null) => ({
    exists: data !== null,
    data: () => data ?? undefined,
  });

  mockedGetAdminDb.mockReturnValue({
    collection: (collectionName: string) => ({
      doc: () => ({
        get: async () =>
          snapshot(
            collectionName === 'users'
              ? userData
              : collectionName === 'sites'
                ? siteData
                : null,
          ),
        // `sites/{siteId}/members/{uid}` — where site access resolves from.
        collection: (sub: string) => ({
          doc: () => ({
            get: async () => snapshot(sub === 'members' ? memberData : null),
          }),
        }),
      }),
    }),
    // `resolveSiteAccess` reads its three documents in ONE batch. Real getAll
    // preserves argument order, so delegating to each ref matches its shape.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
  } as unknown as ReturnType<typeof getAdminDb>);
}

function mockPlatformUser(data: PlatformUserData | null): void {
  mockFirestoreDocs({ user: data });
}

function mockPlatformRole(role: 'superadmin' | 'admin' | 'member' | null): void {
  mockPlatformUser(role === null ? null : { role });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAssertSite.mockResolvedValue({ siteId: SITE_ID, siteData: {}, machineIds: null });
  mockPlatformRole('superadmin');
});

describe('requireSiteAuthAndScope — site resource matrix', () => {
  describe.each(ALL_PERMISSIONS)('permission=%s', (permission) => {
    it(`200 when site scope grants ${permission} on the target site`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'site', id: SITE_ID, permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, permission);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.scopeCheck.isLegacy).toBe(false);
      }
    });

    it(`200 when site wildcard scope grants ${permission}`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'site', id: '*', permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, permission);
      expect(result.ok).toBe(true);
    });

    it(`403 scope_insufficient when scope is wrong resource but has ${permission}`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'roost', id: '*', permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, permission);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
        const body = await result.response.json();
        expect(body.code).toBe('scope_insufficient');
        expect(body.required).toEqual({ resource: 'site', id: SITE_ID, permission });
      }
    });

    it(`403 when scope targets a different siteId with ${permission}`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'site', id: OTHER_SITE_ID, permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, permission);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });

    it(`403 when scope has different permission than ${permission}`, async () => {
      const otherPerm: ApiKeyPermission = permission === 'read' ? 'write' : 'read';
      const scopes: ApiKeyScope[] = [
        { resource: 'site', id: SITE_ID, permissions: [otherPerm] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, permission);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });
  });
});

describe('requireRoostAuthAndScope — roost resource matrix', () => {
  describe.each(ALL_PERMISSIONS)('permission=%s', (permission) => {
    it(`200 when roost scope grants ${permission} on the target roost`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'roost', id: ROOST_ID, permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireRoostAuthAndScope(
        makeRequest(),
        SITE_ID,
        ROOST_ID,
        permission,
      );
      expect(result.ok).toBe(true);
    });

    it(`200 when roost wildcard scope grants ${permission}`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'roost', id: '*', permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireRoostAuthAndScope(
        makeRequest(),
        SITE_ID,
        ROOST_ID,
        permission,
      );
      expect(result.ok).toBe(true);
    });

    it(`403 when scope targets a different roostId with ${permission}`, async () => {
      const scopes: ApiKeyScope[] = [
        { resource: 'roost', id: OTHER_ROOST_ID, permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireRoostAuthAndScope(
        makeRequest(),
        SITE_ID,
        ROOST_ID,
        permission,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });

    it(`403 when site-scope is held instead of roost-scope for ${permission}`, async () => {
      // Site write does NOT imply roost write: strict per (resource, id, perm).
      const scopes: ApiKeyScope[] = [
        { resource: 'site', id: SITE_ID, permissions: [permission] },
      ];
      mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
      const result = await requireRoostAuthAndScope(
        makeRequest(),
        SITE_ID,
        ROOST_ID,
        permission,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(403);
      }
    });
  });
});

describe('requireDistributionManageCapability', () => {
  it('allows a site owner, whose global role grants nothing', async () => {
    // Self-serve owners are global role `member`; the owner membership row is
    // what carries DISTRIBUTION_MANAGE.
    mockFirestoreDocs({
      site: { owner: 'user-test' },
      user: { role: 'member', sites: [] },
      member: { uid: 'user-test', role: 'owner', status: 'active' },
    });

    const result = await requireDistributionManageCapability(sessionAuth(), SITE_ID);

    expect(result).toBeNull();
  });

  it('denies a user the site points at who holds no membership row', async () => {
    // `sites/{siteId}.owner` is no longer read on the auth path. This used to
    // pass through an ownership short-circuit that bypassed the matrix entirely.
    mockFirestoreDocs({
      site: { owner: 'user-test' },
      user: { role: 'member', sites: [] },
      member: null,
    });

    const result = await requireDistributionManageCapability(sessionAuth(), SITE_ID);

    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
  });

  it('denies a plain member of the site', async () => {
    mockFirestoreDocs({
      site: { owner: 'someone-else' },
      user: { role: 'member', sites: [] },
      member: { uid: 'user-test', role: 'member', status: 'active' },
    });

    const result = await requireDistributionManageCapability(sessionAuth(), SITE_ID);

    expect(result).not.toBeNull();
    if (result) {
      expect(result.status).toBe(403);
      const body = await result.json();
      expect(body.detail).toBe('capability not granted');
    }
  });
});

describe('machine-scope enforcement (via scopeMatches directly)', () => {
  it.each(ALL_PERMISSIONS)('machine scope accepts %s on exact machine id', async (permission) => {
    // No route uses the 'machine' dimension yet; the helper must still take it.
    const { requireScope } = jest.requireActual('@/lib/apiAuth.server') as typeof import('@/lib/apiAuth.server');
    const auth = authFromScopes([
      { resource: 'machine', id: 'm-1', permissions: [permission] },
    ]);
    expect(() => requireScope(auth, 'machine', 'm-1', permission)).not.toThrow();
  });

  it('machine scope rejects mismatched permission', () => {
    const { requireScope } = jest.requireActual('@/lib/apiAuth.server') as typeof import('@/lib/apiAuth.server');
    const auth = authFromScopes([
      { resource: 'machine', id: 'm-1', permissions: ['read'] },
    ]);
    expect(() => requireScope(auth, 'machine', 'm-1', 'write')).toThrow(
      expect.objectContaining({ status: 403, code: 'scope_insufficient' }),
    );
  });
});

describe('legacy-key empty scopes', () => {
  it('rejects site scope check with empty legacy scopes', async () => {
    mockedResolveAuth.mockResolvedValue(authFromScopes([]));
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('scope_insufficient');
      expect(body.required).toEqual({
        resource: 'site',
        id: SITE_ID,
        permission: 'write',
      });
    }
  });

  it('applyAuthDeprecations sets X-Roost-Deprecation header on legacy bypass', () => {
    const response = NextResponse.json({ ok: true });
    const decorated = applyAuthDeprecations(response, { isLegacy: true });
    expect(decorated.headers.get('X-Roost-Deprecation')).toBe('legacy-key-scope-missing');
  });

  it('applyAuthDeprecations is a no-op for non-legacy', () => {
    const response = NextResponse.json({ ok: true });
    const decorated = applyAuthDeprecations(response, { isLegacy: false });
    expect(decorated.headers.get('X-Roost-Deprecation')).toBeNull();
  });

  it('legacy key + roost route also rejects on scope check', async () => {
    mockedResolveAuth.mockResolvedValue(authFromScopes([]));
    const result = await requireRoostAuthAndScope(
      makeRequest(),
      SITE_ID,
      ROOST_ID,
      'rollback',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('scope_insufficient');
      expect(body.required).toEqual({
        resource: 'roost',
        id: ROOST_ID,
        permission: 'rollback',
      });
    }
  });
});

describe('session / id-token auth (no API key)', () => {
  it('bypasses scope check entirely', async () => {
    mockedResolveAuth.mockResolvedValue(sessionAuth());
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'admin');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scopeCheck.isLegacy).toBe(false);
  });

  it('does NOT emit api_key_used audit event for session auth', async () => {
    mockedResolveAuth.mockResolvedValue(sessionAuth());
    await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(mockedAuditEmit).not.toHaveBeenCalled();
  });
});

describe('requirePlatformAuthAndScope', () => {
  it('allows a superadmin session without API-key scope', async () => {
    mockedResolveAuth.mockResolvedValue(sessionAuth());
    mockPlatformRole('superadmin');

    const result = await requirePlatformAuthAndScope(makeRequest(), 'user', 'admin');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scopeCheck.isLegacy).toBe(false);
    }
  });

  it('rejects a superadmin API key that lacks the required platform scope', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([{ resource: 'installer', id: '*', permissions: ['read'] }]),
    );
    mockPlatformRole('superadmin');

    const result = await requirePlatformAuthAndScope(makeRequest(), 'user', 'admin');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('scope_insufficient');
      expect(body.required).toEqual({ resource: 'user', id: '*', permission: 'admin' });
    }
  });

  it('rejects a non-superadmin API key even when the key has platform scope', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([{ resource: 'user', id: '*', permissions: ['admin'] }]),
    );
    mockPlatformRole('member');

    const result = await requirePlatformAuthAndScope(makeRequest(), 'user', 'admin');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('forbidden');
      expect(body.detail).toBe('superadmin access required');
    }
  });

  it('rejects a soft-deleted superadmin before platform scope checks', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([{ resource: 'user', id: '*', permissions: ['admin'] }]),
    );
    mockPlatformUser({ role: 'superadmin', deletedAt: Date.now() });

    const result = await requirePlatformAuthAndScope(makeRequest(), 'user', 'admin');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('forbidden');
      expect(body.detail).toBe('user is deleted or inactive');
    }
    expect(mockedAuditEmit).not.toHaveBeenCalled();
  });

  it('rejects a legacy superadmin key without required platform scope', async () => {
    mockedResolveAuth.mockResolvedValue(authFromScopes([]));
    mockPlatformRole('superadmin');

    const result = await requirePlatformAuthAndScope(makeRequest(), 'installer', 'admin');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('scope_insufficient');
      expect(body.required).toEqual({
        resource: 'installer',
        id: '*',
        permission: 'admin',
      });
    }
  });
});

describe('audit-log emission', () => {
  it('emits api_key_used when API key auth succeeds', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: SITE_ID, permissions: ['write'] },
      ]),
    );
    await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(mockedAuditEmit).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit when scope check fails (no successful resolution)', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: SITE_ID, permissions: ['read'] },
      ]),
    );
    await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(mockedAuditEmit).not.toHaveBeenCalled();
  });

  it('does NOT emit for legacy key with empty scopes because scope check fails', async () => {
    mockedResolveAuth.mockResolvedValue(authFromScopes([]));
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    expect(mockedAuditEmit).not.toHaveBeenCalled();
  });
});

describe('input validation', () => {
  it('400 when siteId has invalid format', async () => {
    const result = await requireSiteAuthAndScope(
      makeRequest(),
      'bad site id with spaces',
      'write',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });

  it('400 when roostId has invalid format', async () => {
    const result = await requireRoostAuthAndScope(
      makeRequest(),
      SITE_ID,
      'short',
      'write',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
    }
  });
});

describe('site-access failures', () => {
  it('404 when assertUserHasSiteAccess throws 404 (site not found)', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: '*', permissions: ['write'] },
      ]),
    );
    mockedAssertSite.mockRejectedValue(new ApiAuthError(404, 'not found'));
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  it('collapses 403 to 404 (anti-enumeration)', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: '*', permissions: ['write'] },
      ]),
    );
    mockedAssertSite.mockRejectedValue(new ApiAuthError(403, 'no access'));
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });
});

describe('rotation grace + expiration (end-to-end via resolveAuth failures)', () => {
  it('surfaces token_expired as 401 with problem+json body', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    const expiredAt = Date.now() - 1000;
    mockedResolveAuth.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: API key expired', {
        code: 'token_expired',
        details: { expiredAt },
      }),
    );
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe('token_expired');
      expect(body.expiredAt).toBe(expiredAt);
    }
  });

  it('surfaces retired-past-grace as plain 401 (mirrors revocation)', async () => {
    const { ApiAuthError } = jest.requireActual('@/lib/apiAuth.server');
    mockedResolveAuth.mockRejectedValue(
      new ApiAuthError(401, 'Unauthorized: Invalid API key'),
    );
    const result = await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe('requireAgentOrSiteAuthAndScope — operator fallthrough', () => {
  it('operator with scoped key passes via requireSiteAuthAndScope path', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: SITE_ID, permissions: ['read'] },
      ]),
    );
    const result = await requireAgentOrSiteAuthAndScope(makeRequest(), SITE_ID, 'read');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isAgent).toBe(false);
    }
  });

  it('operator with insufficient scope gets 403', async () => {
    mockedResolveAuth.mockResolvedValue(
      authFromScopes([
        { resource: 'site', id: SITE_ID, permissions: ['read'] },
      ]),
    );
    const result = await requireAgentOrSiteAuthAndScope(makeRequest(), SITE_ID, 'write');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.code).toBe('scope_insufficient');
    }
  });

  it('400 when siteId invalid', async () => {
    const result = await requireAgentOrSiteAuthAndScope(
      makeRequest(),
      'bad site id with spaces',
      'read',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});

describe('machine scope: a key owned by a member scoped to m1', () => {
  function scopedKey(scopes: ApiKeyScope[]): void {
    mockedResolveAuth.mockResolvedValue(authFromScopes(scopes));
    mockedAssertSite.mockResolvedValue({ siteId: SITE_ID, siteData: {}, machineIds: ['m1'] });
  }

  async function expectRefusal(
    result: { ok: true } | { ok: false; response: NextResponse },
    status: number,
    detail: string,
  ): Promise<void> {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(status);
      expect((await result.response.json()).detail).toBe(detail);
    }
  }

  it('requireSiteAuthAndScope refuses an access answer with no machineIds, not reading it as the whole site', async () => {
    mockedResolveAuth.mockResolvedValue(sessionAuth());
    mockedAssertSite.mockResolvedValue({ siteId: SITE_ID, siteData: {} } as never);
    await expectRefusal(
      await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'read'),
      403,
      'capability not granted',
    );
  });

  it('requireSiteAuthAndScope refuses it 403 although the key holds the site scope', async () => {
    scopedKey([{ resource: 'site', id: SITE_ID, permissions: ['read'] }]);
    await expectRefusal(
      await requireSiteAuthAndScope(makeRequest(), SITE_ID, 'read'),
      403,
      'capability not granted',
    );
    expect(mockedAuditEmit).not.toHaveBeenCalled();
  });

  it('requireSiteMachineAuthAndScope answers 404 on m2', async () => {
    scopedKey([{ resource: 'site', id: SITE_ID, permissions: ['read'] }]);
    await expectRefusal(
      await requireSiteMachineAuthAndScope(makeRequest(), SITE_ID, 'm2', 'read'),
      404,
      'machine not found or no access',
    );
  });

  it('requireMachineAuthAndScope answers 404 on m2 to a machine=* key', async () => {
    scopedKey([{ resource: 'machine', id: '*', permissions: ['write'] }]);
    await expectRefusal(
      await requireMachineAuthAndScope(makeRequest(), SITE_ID, 'm2', 'write'),
      404,
      'machine not found or no access',
    );
  });

  it('requireRoostAuthAndScope refuses a read 403', async () => {
    scopedKey([{ resource: 'roost', id: '*', permissions: ['read'] }]);
    await expectRefusal(
      await requireRoostAuthAndScope(makeRequest(), SITE_ID, ROOST_ID, 'read'),
      403,
      'capability not granted',
    );
  });

  it('requireChatAuthAndScope admits it with its machines', async () => {
    scopedKey([{ resource: 'chat', id: SITE_ID, permissions: ['read'] }]);
    const result = await requireChatAuthAndScope(makeRequest(), SITE_ID, 'read');
    expect(result.ok && result.machineIds).toEqual(['m1']);
  });

  it("requireAgentOrSiteAuthAndScope's user path inherits the default refusal", async () => {
    scopedKey([{ resource: 'site', id: SITE_ID, permissions: ['read'] }]);
    await expectRefusal(
      await requireAgentOrSiteAuthAndScope(makeRequest(), SITE_ID, 'read'),
      403,
      'capability not granted',
    );
  });

  it('requirePlatformAuthAndScope carries no machine scope', async () => {
    mockedResolveAuth.mockResolvedValue(sessionAuth());
    const result = await requirePlatformAuthAndScope(makeRequest(), 'user', 'read');
    expect(result.ok && result.machineIds).toBeNull();
  });
});
