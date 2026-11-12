/** @jest-environment node */

import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';

const mockGetSession = jest.fn();
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: (...args: unknown[]) => mockGetSession(...args),
}));

const mockVerifyIdToken = jest.fn();
const mockDocGet = jest.fn();
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);

const mockDoc = jest.fn();
const mockInnerDoc = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: mockVerifyIdToken }),
  getAdminDb: () => ({
    // Batched read used by lib/sitePolicy.server.ts. Real getAll preserves
    // argument order and yields a non-existent snapshot for a missing doc,
    // so delegating to each ref's own get() matches its observable shape.
    getAll: (...refs: Array<{ get: () => Promise<unknown> }>) =>
      Promise.all(refs.map((r) => r.get())),
    collection: (colName: string) => ({
      doc: (docId: string) => {
        mockDoc(colName, docId);
        return {
          get: () => mockDocGet(colName, docId),
          collection: (innerCol: string) => ({
            doc: (innerDocId: string) => {
              mockInnerDoc(innerCol, innerDocId);
              return {
                // Site access reads `sites/{id}/members/{uid}` now, so a
                // subcollection doc has to answer reads and not just writes.
                get: () => mockDocGet(innerCol, innerDocId),
                update: mockDocUpdate,
              };
            },
          }),
        };
      },
    }),
  }),
}));

const mockEmitApiKeyUsed: jest.Mock = jest.fn();
const mockScopeFingerprint: jest.Mock = jest.fn((_scopes?: unknown) => 'test-fingerprint');
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: (...args: unknown[]) => mockEmitApiKeyUsed(...args),
  scopeFingerprint: (...args: unknown[]) => mockScopeFingerprint(...args),
}));

import {
  ApiAuthError,
  applyAuthDeprecations,
  auditApiKeyUse,
  requireSession,
  requireSessionOrIdToken,
  requireAdmin,
  requireAdminOrIdToken,
  requireScope,
  requireSessionUser,
  resolveAuth,
  assertActiveUser,
  assertUserHasSiteAccess,
  assertUserHasSiteCapability,
  type ApiKeyContext,
  type ResolvedAuth,
} from '@/lib/apiAuth.server';
import { Capability } from '@/lib/capabilities';

function makeRequest(url = 'http://localhost/test', init?: RequestInit) {
  return new NextRequest(new URL(url), init as unknown as ConstructorParameters<typeof NextRequest>[1]);
}

function validSession(overrides = {}) {
  return {
    userId: 'user-123',
    expiresAt: Date.now() + 60_000,
    destroy: jest.fn(),
    ...overrides,
  };
}

/** Shorthand: api_keys doc lookup mock that returns the given lookup payload. */
function apiKeyLookup(payload: Record<string, unknown>) {
  return (col: string) => {
    if (col === 'api_keys') {
      return Promise.resolve({ exists: true, data: () => payload });
    }
    return Promise.resolve({ exists: false });
  };
}

function keyContext(overrides: Partial<ApiKeyContext> = {}): ApiKeyContext {
  return {
    keyId: 'k1',
    scopes: null,
    environment: 'live',
    expiresAt: null,
    isLegacy: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LEGACY_API_KEY_BYPASS_ENABLED;
  delete process.env.LEGACY_API_KEY_ALLOW_HASH_LIST;
});

afterEach(() => {
  delete process.env.LEGACY_API_KEY_BYPASS_ENABLED;
  delete process.env.LEGACY_API_KEY_ALLOW_HASH_LIST;
});

// requireSession

describe('requireSession', () => {
  it('returns userId when session is valid', async () => {
    mockGetSession.mockResolvedValue(validSession());
    const result = await requireSession(makeRequest());
    expect(result).toBe('user-123');
  });

  it('throws 401 when session has no userId', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    await expect(requireSession(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('throws 401 when session has no expiresAt', async () => {
    mockGetSession.mockResolvedValue(validSession({ expiresAt: null }));
    await expect(requireSession(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('throws 401 when session is expired and calls destroy', async () => {
    const session = validSession({ expiresAt: Date.now() - 10_000 });
    mockGetSession.mockResolvedValue(session);
    await expect(requireSession(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(session.destroy).toHaveBeenCalled();
  });
});

// requireSessionOrIdToken

describe('requireSessionOrIdToken', () => {
  it('returns userId from valid session', async () => {
    mockGetSession.mockResolvedValue(validSession());
    const result = await requireSessionOrIdToken(makeRequest());
    expect(result).toBe('user-123');
  });

  it('falls back to Bearer token when session throws', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'token-user' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer test-token' },
    });
    const result = await requireSessionOrIdToken(req);
    expect(result).toBe('token-user');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('test-token');
  });

  it('accepts lowercase "bearer" prefix (case-insensitive)', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'token-user-2' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'bearer my-token' },
    });
    const result = await requireSessionOrIdToken(req);
    expect(result).toBe('token-user-2');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('my-token');
  });

  it('throws 401 when session fails and no Authorization header', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    await expect(requireSessionOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('throws 401 when session fails and Bearer token is invalid', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockRejectedValue(new Error('bad token'));
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer bad-token' },
    });
    await expect(requireSessionOrIdToken(req)).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        message: expect.stringContaining('Invalid ID token'),
      }),
    );
  });

  it('re-throws ApiAuthError when session fails and no Bearer header', async () => {
    const sessionError = new ApiAuthError(401, 'Unauthorized: Session expired');
    mockGetSession.mockRejectedValue(sessionError);
    await expect(requireSessionOrIdToken(makeRequest())).rejects.toBe(sessionError);
  });

  it('treats empty Authorization header as no bearer', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: '' },
    });
    await expect(requireSessionOrIdToken(req)).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(mockVerifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects agent-role bearer tokens with 403 when rejectAgentTokens is set', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'agent-uid', role: 'agent' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer agent-token' },
    });
    await expect(
      requireSessionOrIdToken(req, { rejectAgentTokens: true }),
    ).rejects.toThrow(expect.objectContaining({ status: 403 }));
  });

  it('allows agent-role bearer tokens by default (no behavior change for existing callers)', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'agent-uid', role: 'agent' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer agent-token' },
    });
    await expect(requireSessionOrIdToken(req)).resolves.toBe('agent-uid');
  });

  it('allows non-agent bearer tokens when rejectAgentTokens is set', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'human-uid', role: 'member' });
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer human-token' },
    });
    await expect(
      requireSessionOrIdToken(req, { rejectAgentTokens: true }),
    ).resolves.toBe('human-uid');
  });
});

// requireAdminOrIdToken

describe('requireAdminOrIdToken', () => {
  const apiKeyHash = createHash('sha256').update('owk_test123').digest('hex');

  it('returns userId for superadmin via x-api-key header', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys')
        return Promise.resolve({
          exists: true,
          data: () => ({
            userId: 'super-1',
            keyId: 'k1',
            scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
            expiresAt: Date.now() + 60_000,
          }),
        });
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'superadmin' }) });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test', {
      headers: { 'x-api-key': 'owk_test123' },
    });
    const result = await requireAdminOrIdToken(req);
    expect(result).toBe('super-1');
    expect(mockDoc).toHaveBeenCalledWith('api_keys', apiKeyHash);
  });

  it('returns userId for superadmin via api_key query param', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys')
        return Promise.resolve({
          exists: true,
          data: () => ({
            userId: 'super-2',
            keyId: 'k2',
            scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
            expiresAt: Date.now() + 60_000,
          }),
        });
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'superadmin' }) });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test?api_key=owk_test456');
    const result = await requireAdminOrIdToken(req);
    expect(result).toBe('super-2');
  });

  it('returns userId for superadmin via Authorization Bearer owk_', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys')
        return Promise.resolve({
          exists: true,
          data: () => ({
            userId: 'super-3',
            keyId: 'k3',
            scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
            expiresAt: Date.now() + 60_000,
          }),
        });
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'superadmin' }) });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer owk_test789' },
    });
    const result = await requireAdminOrIdToken(req);
    expect(result).toBe('super-3');
  });

  it('throws 401 for invalid API key (doc does not exist)', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys') return Promise.resolve({ exists: false });
      return Promise.resolve({ exists: false });
    });

    const req = makeRequest('http://localhost/test', {
      headers: { 'x-api-key': 'owk_invalid' },
    });
    await expect(requireAdminOrIdToken(req)).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('falls back to session/token when no API key present', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'session-super' }));
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'superadmin' }) });
      return Promise.resolve({ exists: false });
    });

    const result = await requireAdminOrIdToken(makeRequest());
    expect(result).toBe('session-super');
  });

  it('throws 403 for non-superadmin user (member)', async () => {
    mockGetSession.mockResolvedValue(validSession());
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'member' }) });
      return Promise.resolve({ exists: false });
    });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('throws 403 for site-admin user (not platform-superadmin)', async () => {
    mockGetSession.mockResolvedValue(validSession());
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'admin' }) });
      return Promise.resolve({ exists: false });
    });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('throws 403 when user doc does not exist', async () => {
    mockGetSession.mockResolvedValue(validSession());
    mockDocGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('throws 403 when a superadmin user doc is soft-deleted', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'deleted-super' }));
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'superadmin', deletedAt: 1700000000000 }),
        });
      return Promise.resolve({ exists: false });
    });

    await expect(requireAdminOrIdToken(makeRequest())).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'user_inactive' }),
    );
  });
});

// requireAdmin

describe('requireAdmin', () => {
  it('delegates to requireAdminOrIdToken', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'super-user' }));
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'users')
        return Promise.resolve({ exists: true, data: () => ({ role: 'superadmin' }) });
      return Promise.resolve({ exists: false });
    });

    const result = await requireAdmin(makeRequest());
    expect(result).toBe('super-user');
  });
});

// requireSessionUser

describe('requireSessionUser', () => {
  it('returns userId when session matches', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'user-abc' }));
    const result = await requireSessionUser(makeRequest(), 'user-abc');
    expect(result).toBe('user-abc');
  });

  it('throws 403 when session userId does not match', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'user-abc' }));
    await expect(requireSessionUser(makeRequest(), 'user-other')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('propagates 401 when the session itself is invalid', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: null }));
    await expect(requireSessionUser(makeRequest(), 'user-abc')).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });
});

// assertUserHasSiteAccess

describe('assertActiveUser', () => {
  it('returns user data when the user doc exists and is not deleted', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'member', sites: ['site-1'] }),
    });

    await expect(assertActiveUser('user-active')).resolves.toMatchObject({
      role: 'member',
      sites: ['site-1'],
    });
  });

  it('throws user_inactive when the user doc is missing', async () => {
    mockDocGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(assertActiveUser('user-missing')).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'user_inactive' }),
    );
  });

  it('throws user_inactive when the user doc is soft-deleted', async () => {
    mockDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ role: 'superadmin', deletedAt: 1700000000000 }),
    });

    await expect(assertActiveUser('user-deleted')).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'user_inactive' }),
    );
  });
});

describe('assertUserHasSiteAccess', () => {
  it('allows access when the user holds an owner membership', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'user-1', name: 'Site A' }) });
      if (col === 'members')
        return Promise.resolve({
          exists: true,
          data: () => ({ uid: 'user-1', role: 'owner', status: 'active' }),
        });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'member', sites: [] }),
        });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-1', 'site-1');
    expect(result.siteId).toBe('site-1');
    expect(result.siteData).toEqual({ owner: 'user-1', name: 'Site A' });
  });

  it('allows access when user is superadmin', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'other', name: 'Site B' }) });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'superadmin', sites: [] }),
        });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-2', 'site-2');
    expect(result.siteId).toBe('site-2');
  });

  it('allows access when the user holds a member membership', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'other', name: 'Site C' }) });
      if (col === 'members')
        return Promise.resolve({
          exists: true,
          data: () => ({ uid: 'user-3', role: 'member', status: 'active' }),
        });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'member', sites: ['site-3'] }),
        });
      return Promise.resolve({ exists: false });
    });

    const result = await assertUserHasSiteAccess('user-3', 'site-3');
    expect(result.siteId).toBe('site-3');
  });

  it('throws 403 when user has no access', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'other' }) });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'member', sites: [] }),
        });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-4', 'site-4')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('throws 404 when site does not exist', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites') return Promise.resolve({ exists: false });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-5', 'site-missing')).rejects.toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('rejects when the user doc is missing', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'other' }) });
      if (col === 'users') return Promise.resolve({ exists: false, data: () => undefined });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-6', 'site-6')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it('rejects a soft-deleted user even when they own the site', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'user-deleted' }) });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({
            role: 'superadmin',
            sites: ['site-deleted'],
            deletedAt: 1700000000000,
          }),
        });
      return Promise.resolve({ exists: false });
    });

    await expect(
      assertUserHasSiteAccess('user-deleted', 'site-deleted'),
    ).rejects.toThrow(
      expect.objectContaining({ status: 403, code: 'user_inactive' }),
    );
  });

  it('tolerates non-array sites field on user doc', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'sites')
        return Promise.resolve({ exists: true, data: () => ({ owner: 'other' }) });
      if (col === 'users')
        return Promise.resolve({
          exists: true,
          data: () => ({ role: 'member', sites: 'not-an-array' }),
        });
      return Promise.resolve({ exists: false });
    });

    await expect(assertUserHasSiteAccess('user-7', 'site-7')).rejects.toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

/** a site, an active user with no global privilege, and their member row on it */
function mockMemberOn(memberRow: Record<string, unknown>) {
  mockDocGet.mockImplementation((col: string) => {
    if (col === 'sites') return Promise.resolve({ exists: true, data: () => ({ name: 'Site S' }) });
    if (col === 'users') return Promise.resolve({ exists: true, data: () => ({ role: 'member' }) });
    if (col === 'members') return Promise.resolve({ exists: true, data: () => memberRow });
    return Promise.resolve({ exists: false });
  });
}

describe('assertUserHasSiteAccess machine scope', () => {
  it("returns a scoped member's machines", async () => {
    mockMemberOn({ uid: 'user-s', role: 'member', status: 'active', machineIds: ['m1'] });
    const result = await assertUserHasSiteAccess('user-s', 'site-s');
    expect(result.machineIds).toEqual(['m1']);
  });

  it('returns null for a whole-site member', async () => {
    mockMemberOn({ uid: 'user-s', role: 'member', status: 'active' });
    const result = await assertUserHasSiteAccess('user-s', 'site-s');
    expect(result.machineIds).toBeNull();
  });
});

describe('assertUserHasSiteCapability', () => {
  it('refuses MACHINE_ENROLL to a scoped admin', async () => {
    mockMemberOn({ uid: 'user-s', role: 'admin', status: 'active', machineIds: ['m1'] });
    await expect(
      assertUserHasSiteCapability('user-s', 'site-s', Capability.MACHINE_ENROLL),
    ).rejects.toThrow(
      expect.objectContaining({ status: 403, message: 'Forbidden: capability not granted' }),
    );
  });

  it('refuses MACHINE_ENROLL to a member set to swoop control', async () => {
    mockMemberOn({ uid: 'user-s', role: 'member', status: 'active', swoop: 'control' });
    await expect(
      assertUserHasSiteCapability('user-s', 'site-s', Capability.MACHINE_ENROLL),
    ).rejects.toThrow(
      expect.objectContaining({ status: 403, message: 'Forbidden: capability not granted' }),
    );
  });

  it('allows MACHINE_ENROLL to a whole-site admin', async () => {
    mockMemberOn({ uid: 'user-s', role: 'admin', status: 'active' });
    await expect(
      assertUserHasSiteCapability('user-s', 'site-s', Capability.MACHINE_ENROLL),
    ).resolves.toMatchObject({ siteId: 'site-s', siteData: { name: 'Site S' } });
  });
});

// resolveAuth

describe('resolveAuth', () => {
  function apiKeyReq(rawKey: string, via: 'header' | 'query' | 'bearer' = 'header') {
    if (via === 'query') {
      return makeRequest(`http://localhost/test?api_key=${encodeURIComponent(rawKey)}`);
    }
    if (via === 'bearer') {
      return makeRequest('http://localhost/test', {
        headers: { authorization: `Bearer ${rawKey}` },
      });
    }
    return makeRequest('http://localhost/test', { headers: { 'x-api-key': rawKey } });
  }

  it('returns session-auth ResolvedAuth with null keyContext when no API key', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'u-session' }));
    const auth = await resolveAuth(makeRequest());
    expect(auth.userId).toBe('u-session');
    expect(auth.keyContext).toBeNull();
  });

  it('resolves a valid non-expired key with scopes', async () => {
    const futureExpiry = Date.now() + 60_000;
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u1',
        keyId: 'k1',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
        expiresAt: futureExpiry,
      }),
    );

    const auth = await resolveAuth(apiKeyReq('owk_live_valid'));
    expect(auth.userId).toBe('u1');
    expect(auth.keyContext).not.toBeNull();
    expect(auth.keyContext?.isLegacy).toBe(false);
    expect(auth.keyContext?.scopes).toEqual([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(auth.keyContext?.environment).toBe('live');
    expect(auth.keyContext?.expiresAt).toBe(futureExpiry);
    expect(auth.keyContext?.keyId).toBe('k1');
  });

  it('resolves via api_key query parameter', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-q',
        keyId: 'k-q',
        environment: 'test',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
        expiresAt: Date.now() + 60_000,
      }),
    );

    const auth = await resolveAuth(apiKeyReq('owk_q', 'query'));
    expect(auth.userId).toBe('u-q');
    expect(auth.keyContext?.environment).toBe('test');
  });

  it('resolves via Authorization: Bearer owk_*', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-b',
        keyId: 'k-b',
        environment: 'live',
        scopes: [{ resource: 'roost', id: 'r1', permissions: ['write'] }],
        expiresAt: Date.now() + 60_000,
      }),
    );

    const auth = await resolveAuth(apiKeyReq('owk_b', 'bearer'));
    expect(auth.userId).toBe('u-b');
    expect(auth.keyContext?.scopes?.[0].resource).toBe('roost');
  });

  it('falls through to session auth when Bearer token is not an owk_ key', async () => {
    mockGetSession.mockResolvedValue(validSession({ userId: 'u-tok' }));
    mockVerifyIdToken.mockResolvedValue({ uid: 'u-id-token' });
    // Bearer without the owk_ prefix: extractApiKey returns null, so the session wins.
    const req = makeRequest('http://localhost/test', {
      headers: { authorization: 'Bearer eyJ.id-token.xyz' },
    });
    const auth = await resolveAuth(req);
    expect(auth.userId).toBe('u-tok');
    expect(auth.keyContext).toBeNull();
  });

  it('throws 401 token_expired with expiredAt when expiresAt is in the past', async () => {
    const pastExpiry = Date.now() - 1000;
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u2',
        keyId: 'k2',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
        expiresAt: pastExpiry,
      }),
    );

    await expect(resolveAuth(apiKeyReq('owk_live_expired'))).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        code: 'token_expired',
        details: { expiredAt: pastExpiry },
      }),
    );
  });

  it('rejects revoked keys', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-revoked',
        keyId: 'k-revoked',
        environment: 'live',
        revokedAt: Date.now(),
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
        expiresAt: Date.now() - 1000,
      }),
    );

    await expect(resolveAuth(apiKeyReq('owk_revoked'))).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        message: 'Unauthorized: Invalid API key',
      }),
    );
  });

  it('allows a key whose expiresAt is in the near future (boundary)', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u3',
        keyId: 'k3',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
        expiresAt: Date.now() + 10_000,
      }),
    );
    const auth = await resolveAuth(apiKeyReq('owk_live_boundary'));
    expect(auth.keyContext?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('rejects a key with no scopes field without bypass env', async () => {
    mockDocGet.mockImplementation(apiKeyLookup({ userId: 'u4', keyId: 'k4' }));
    await expect(resolveAuth(apiKeyReq('owk_legacy'))).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        message: 'Unauthorized: Invalid API key',
      }),
    );
  });

  it('rejects a key with an empty scopes[] array without bypass env', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u4b',
        keyId: 'k4b',
        environment: 'live',
        scopes: [],
      }),
    );
    await expect(resolveAuth(apiKeyReq('owk_empty_scopes'))).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        message: 'Unauthorized: Invalid API key',
      }),
    );
  });

  it('rejects legacy keys without bypass env', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-legacy-no-bypass',
        keyId: 'k-legacy-no-bypass',
        environment: 'live',
        scopes: [],
      }),
    );

    await expect(resolveAuth(apiKeyReq('owk_legacy_no_bypass'))).rejects.toThrow(
      expect.objectContaining({
        status: 401,
        message: 'Unauthorized: Invalid API key',
      }),
    );
  });

  it('allowlisted legacy key resolves but cannot pass requireScope', async () => {
    const rawKey = 'owk_allowlisted_legacy';
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    process.env.LEGACY_API_KEY_BYPASS_ENABLED = 'true';
    process.env.LEGACY_API_KEY_ALLOW_HASH_LIST = keyHash;
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-legacy-allowed',
        keyId: 'k-legacy-allowed',
        environment: 'live',
        scopes: [],
      }),
    );

    const auth = await resolveAuth(apiKeyReq(rawKey));
    expect(auth.keyContext?.isLegacy).toBe(false);
    expect(auth.keyContext?.scopes).toEqual([]);
    expect(() => requireScope(auth, 'roost', 'r1', 'write')).toThrow(
      expect.objectContaining({
        status: 403,
        code: 'scope_insufficient',
        message: 'insufficient scope: requires write on roost:r1',
      }),
    );
  });

  it('rejects rotated key past retiresAt as invalid', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u5',
        keyId: 'k5',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
        expiresAt: Date.now() + 60_000,
        retiresAt: Date.now() - 1000,
      }),
    );

    await expect(resolveAuth(apiKeyReq('owk_live_retired'))).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('allows rotated key still within retiresAt grace', async () => {
    const retiresAt = Date.now() + 30_000;
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u6',
        keyId: 'k6',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
        expiresAt: Date.now() + 60_000,
        retiresAt,
      }),
    );
    const auth = await resolveAuth(apiKeyReq('owk_live_in_grace'));
    expect(auth.keyContext?.retiresAt).toBe(retiresAt);
  });

  it('fires-and-forgets the lastUsedAt update (does not await)', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u7',
        keyId: 'k7',
        environment: 'live',
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
        expiresAt: Date.now() + 60_000,
      }),
    );

    // A rejected update must not fail resolveAuth.
    mockDocUpdate.mockRejectedValueOnce(new Error('firestore unavailable'));

    const auth = await resolveAuth(apiKeyReq('owk_live_ff'));
    expect(auth.userId).toBe('u7');
    expect(mockInnerDoc).toHaveBeenCalledWith('api_keys', 'k7');
  });

  it('throws 401 when the API-key lookup doc does not exist', async () => {
    mockDocGet.mockImplementation((col: string) => {
      if (col === 'api_keys') return Promise.resolve({ exists: false });
      return Promise.resolve({ exists: false });
    });
    await expect(resolveAuth(apiKeyReq('owk_nonexistent'))).rejects.toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('coerces missing environment to null in keyContext', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-env',
        keyId: 'k-env',
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
        expiresAt: Date.now() + 60_000,
      }),
    );
    const auth = await resolveAuth(apiKeyReq('owk_no_env'));
    expect(auth.keyContext?.environment).toBeNull();
  });

  it('coerces missing expiresAt to null in keyContext', async () => {
    mockDocGet.mockImplementation(
      apiKeyLookup({
        userId: 'u-e',
        keyId: 'k-e',
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
      }),
    );
    const auth = await resolveAuth(apiKeyReq('owk_no_expiry'));
    expect(auth.keyContext?.expiresAt).toBeNull();
  });
});

// requireScope

describe('requireScope', () => {
  it('bypasses when session auth (no keyContext)', () => {
    const result = requireScope(
      { userId: 'u1', keyContext: null },
      'roost',
      'r1',
      'write',
    );
    expect(result.isLegacy).toBe(false);
  });

  it('rejects legacy key with empty scopes even when isLegacy is true', () => {
    expect(() =>
      requireScope(
        { userId: 'u1', keyContext: keyContext({ isLegacy: true, scopes: [] }) },
        'roost',
        'r1',
        'write',
      ),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        code: 'scope_insufficient',
        message: 'insufficient scope: requires write on roost:r1',
      }),
    );
  });

  it('rejects missing scopes even when isLegacy is false', () => {
    expect(() =>
      requireScope(
        { userId: 'u1', keyContext: keyContext({ isLegacy: false, scopes: null }) },
        'roost',
        'r1',
        'write',
      ),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        code: 'scope_insufficient',
        message: 'insufficient scope: requires write on roost:r1',
      }),
    );
  });

  it('allows scoped key with exact match', () => {
    const result = requireScope(
      {
        userId: 'u1',
        keyContext: keyContext({
          isLegacy: false,
          scopes: [{ resource: 'roost', id: 'r1', permissions: ['write'] }],
          expiresAt: Date.now() + 60_000,
        }),
      },
      'roost',
      'r1',
      'write',
    );
    expect(result.isLegacy).toBe(false);
  });

  it('allows scoped key with wildcard id', () => {
    const result = requireScope(
      {
        userId: 'u1',
        keyContext: keyContext({
          isLegacy: false,
          scopes: [{ resource: 'roost', id: '*', permissions: ['write'] }],
          expiresAt: Date.now() + 60_000,
        }),
      },
      'roost',
      'r1',
      'write',
    );
    expect(result.isLegacy).toBe(false);
  });

  it('allows when permissions contains more than the required one', () => {
    const result = requireScope(
      {
        userId: 'u1',
        keyContext: keyContext({
          isLegacy: false,
          scopes: [{ resource: 'roost', id: 'r1', permissions: ['read', 'write'] }],
          expiresAt: Date.now() + 60_000,
        }),
      },
      'roost',
      'r1',
      'read',
    );
    expect(result.isLegacy).toBe(false);
  });

  it('throws scope_insufficient for missing permission', () => {
    expect(() =>
      requireScope(
        {
          userId: 'u1',
          keyContext: keyContext({
            isLegacy: false,
            scopes: [{ resource: 'roost', id: 'r1', permissions: ['read'] }],
            expiresAt: Date.now() + 60_000,
          }),
        },
        'roost',
        'r1',
        'write',
      ),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        code: 'scope_insufficient',
        details: { resource: 'roost', id: 'r1', permission: 'write' },
      }),
    );
  });

  it('throws scope_insufficient for wrong resource id', () => {
    expect(() =>
      requireScope(
        {
          userId: 'u1',
          keyContext: keyContext({
            isLegacy: false,
            scopes: [{ resource: 'roost', id: 'r1', permissions: ['write'] }],
            expiresAt: Date.now() + 60_000,
          }),
        },
        'roost',
        'r2',
        'write',
      ),
    ).toThrow(expect.objectContaining({ status: 403, code: 'scope_insufficient' }));
  });

  it('throws scope_insufficient for wrong resource type', () => {
    expect(() =>
      requireScope(
        {
          userId: 'u1',
          keyContext: keyContext({
            isLegacy: false,
            scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
            expiresAt: Date.now() + 60_000,
          }),
        },
        'roost',
        's1',
        'write',
      ),
    ).toThrow(expect.objectContaining({ status: 403, code: 'scope_insufficient' }));
  });

  it('allows when at least one scope entry matches (OR semantics)', () => {
    const result = requireScope(
      {
        userId: 'u1',
        keyContext: keyContext({
          isLegacy: false,
          scopes: [
            { resource: 'site', id: 's1', permissions: ['read'] },
            { resource: 'roost', id: 'r1', permissions: ['write'] },
          ],
          expiresAt: Date.now() + 60_000,
        }),
      },
      'roost',
      'r1',
      'write',
    );
    expect(result.isLegacy).toBe(false);
  });
});

// applyAuthDeprecations

describe('applyAuthDeprecations', () => {
  it('no-ops for a clean scopeCheck (non-legacy, no missingVersion)', () => {
    const res = NextResponse.json({ ok: true });
    const out = applyAuthDeprecations(res, { isLegacy: false });
    expect(out).toBe(res);
    expect(res.headers.get('X-Roost-Deprecation')).toBeNull();
    expect(res.headers.get('X-Roost-Version-Missing')).toBeNull();
    expect(res.headers.get('X-Owlette-Billing-Warning')).toBeNull();
  });

  it('emits both advisories together', () => {
    const res = NextResponse.json({ ok: true });
    applyAuthDeprecations(res, { isLegacy: true, missingVersion: true });
    expect(res.headers.get('X-Roost-Deprecation')).toBe('legacy-key-scope-missing');
    expect(res.headers.get('X-Roost-Version-Missing')).toBe('true');
  });

  it('appends X-Roost-Deprecation for legacy keys', () => {
    const res = NextResponse.json({ ok: true });
    applyAuthDeprecations(res, { isLegacy: true });
    expect(res.headers.get('X-Roost-Deprecation')).toBe('legacy-key-scope-missing');
  });

  it('sets X-Roost-Version-Missing when missingVersion is true', () => {
    const res = NextResponse.json({ ok: true });
    applyAuthDeprecations(res, { isLegacy: false, missingVersion: true });
    expect(res.headers.get('X-Roost-Version-Missing')).toBe('true');
    expect(res.headers.get('X-Roost-Deprecation')).toBeNull();
  });

  it('sets both headers when both flags are set', () => {
    const res = NextResponse.json({ ok: true });
    applyAuthDeprecations(res, { isLegacy: true, missingVersion: true });
    expect(res.headers.get('X-Roost-Deprecation')).toBe('legacy-key-scope-missing');
    expect(res.headers.get('X-Roost-Version-Missing')).toBe('true');
  });

  it('preserves pre-existing response body and status', () => {
    const res = new NextResponse(JSON.stringify({ data: 'x' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
    const out = applyAuthDeprecations(res, { isLegacy: true });
    expect(out.status).toBe(201);
    expect(out.headers.get('Content-Type')).toBe('application/json');
    expect(out.headers.get('X-Roost-Deprecation')).toBe('legacy-key-scope-missing');
  });

  it('appends rather than replaces a pre-existing X-Roost-Deprecation header', () => {
    const res = new NextResponse(null, {
      headers: { 'X-Roost-Deprecation': 'other-signal' },
    });
    applyAuthDeprecations(res, { isLegacy: true });
    const value = res.headers.get('X-Roost-Deprecation');
    expect(value).toContain('other-signal');
    expect(value).toContain('legacy-key-scope-missing');
  });
});

// auditApiKeyUse

describe('auditApiKeyUse', () => {
  it('no-ops when keyContext is null (session auth)', () => {
    const auth: ResolvedAuth = { userId: 'u-session', keyContext: null };
    const req = makeRequest('http://localhost/api/test', { method: 'GET' });
    auditApiKeyUse(auth, 'site-1', req);
    expect(mockEmitApiKeyUsed).not.toHaveBeenCalled();
    expect(mockScopeFingerprint).not.toHaveBeenCalled();
  });

  it('emits api_key_used for a scoped key', () => {
    const auth: ResolvedAuth = {
      userId: 'u-k',
      keyContext: keyContext({
        keyId: 'k-abc',
        scopes: [{ resource: 'site', id: 's1', permissions: ['write'] }],
        environment: 'live',
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      }),
    };
    const req = makeRequest('http://localhost/api/roosts/rst_x/versions', {
      method: 'POST',
    });
    auditApiKeyUse(auth, 'site-1', req);

    expect(mockScopeFingerprint).toHaveBeenCalledWith([
      { resource: 'site', id: 's1', permissions: ['write'] },
    ]);
    expect(mockEmitApiKeyUsed).toHaveBeenCalledWith({
      siteId: 'site-1',
      keyId: 'k-abc',
      scopeFingerprint: 'test-fingerprint',
      environment: 'live',
      endpoint: '/api/roosts/rst_x/versions',
      method: 'POST',
      isLegacy: false,
    });
  });

  it('emits with isLegacy: true for legacy keys', () => {
    const auth: ResolvedAuth = {
      userId: 'u-leg',
      keyContext: keyContext({
        keyId: 'k-legacy',
        scopes: null,
        environment: null,
        expiresAt: null,
        isLegacy: true,
      }),
    };
    const req = makeRequest('http://localhost/api/chunks/check', { method: 'POST' });
    auditApiKeyUse(auth, 'site-legacy', req);

    expect(mockScopeFingerprint).toHaveBeenCalledWith(null);
    expect(mockEmitApiKeyUsed).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: 'site-legacy',
        keyId: 'k-legacy',
        environment: 'unknown',
        endpoint: '/api/chunks/check',
        method: 'POST',
        isLegacy: true,
      }),
    );
  });

  it('coerces missing environment to "unknown" in the emitted event', () => {
    const auth: ResolvedAuth = {
      userId: 'u-noenv',
      keyContext: keyContext({
        keyId: 'k-noenv',
        scopes: [{ resource: 'site', id: 's1', permissions: ['read'] }],
        environment: null,
        expiresAt: Date.now() + 60_000,
        isLegacy: false,
      }),
    };
    const req = makeRequest('http://localhost/api/version', { method: 'GET' });
    auditApiKeyUse(auth, 'site-noenv', req);
    expect(mockEmitApiKeyUsed).toHaveBeenCalledWith(
      expect.objectContaining({ environment: 'unknown' }),
    );
  });
});
