/** @jest-environment node */

import { NextRequest } from 'next/server';

const store = new Map<string, Record<string, unknown> | null>();
const mockRequireSessionOrIdToken = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockAssertUserHasSiteAccess = jest.fn();
const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

// scopeFingerprint stays unmocked: PATCH puts its output in the audit payload, and the
// "never the raw scopes" assertion only means something against the real hash.
jest.mock('@/lib/auditLogClient', () => ({
  ...jest.requireActual('@/lib/auditLogClient'),
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;

    constructor(
      status: number,
      message: string,
      opts?: { code?: string; details?: Record<string, unknown> },
    ) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }

  return {
    ApiAuthError,
    requireSessionOrIdToken: (...args: unknown[]) =>
      mockRequireSessionOrIdToken(...args),
    assertActiveUser: (...args: unknown[]) => mockAssertActiveUser(...args),
    assertUserHasSiteAccess: (...args: unknown[]) =>
      mockAssertUserHasSiteAccess(...args),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDb(),
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

function collectionPath(parts: string[]): string {
  return parts.join('/');
}

function mockDb() {
  return {
    collection: (name: string) => collectionRef([name]),
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        // `{ merge: true }` is modelled, not ignored: revoke relies on merge-set
        // creating-or-merging the lookup doc, and a mock that always replaced it
        // would hide a lost userId/keyId mapping.
        set: (
          ref: { path: string },
          data: Record<string, unknown>,
          options?: { merge?: boolean },
        ) => {
          ops.push(() =>
            store.set(ref.path, options?.merge ? { ...(store.get(ref.path) ?? {}), ...data } : data),
          );
        },
        delete: (ref: { path: string }) => {
          ops.push(() => store.set(ref.path, null));
        },
        update: (ref: { path: string }, data: Record<string, unknown>) => {
          ops.push(() => store.set(ref.path, { ...(store.get(ref.path) ?? {}), ...data }));
        },
        commit: async () => {
          ops.forEach((op) => op());
        },
      };
    },
  };
}

function collectionRef(parts: string[]) {
  const path = collectionPath(parts);
  const ref = {
    doc: (id: string) => docRef([...parts, id]),
    collection: (name: string) => collectionRef([...parts, name]),
    orderBy: () => ref,
    get: async () => ({
      docs: Array.from(store.entries())
        .filter(([docPath, data]) => data && docPath.startsWith(`${path}/`))
        .map(([docPath, data]) => ({
          id: docPath.slice(path.length + 1).split('/')[0],
          data: () => data,
        })),
    }),
  };
  return ref;
}

function docRef(parts: string[]) {
  const path = collectionPath(parts);
  return {
    path,
    collection: (name: string) => collectionRef([...parts, name]),
    get: async () => {
      const data = store.get(path);
      return {
        exists: !!data,
        data: () => data ?? undefined,
      };
    },
  };
}

import {
  enforcePlans,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
} from './helpers/planEnforcement';
import { POST } from '@/app/api/keys/route';
import { DELETE, PATCH } from '@/app/api/keys/[keyId]/route';
import { POST as rotatePOST } from '@/app/api/keys/[keyId]/rotate/route';

function makePost(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function makeDelete(keyId: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/keys/${keyId}`, { method: 'DELETE' }),
    { params: Promise.resolve({ keyId }) },
  );
}

function makePatch(keyId: string, body: Record<string, unknown>) {
  return PATCH(
    new NextRequest(`http://localhost/api/keys/${keyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ keyId }) },
  );
}

function makeRotate(keyId: string, body: Record<string, unknown> = {}) {
  return rotatePOST(
    new NextRequest(`http://localhost/api/keys/${keyId}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ keyId }) },
  );
}

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  store.set('users/user-member', { role: 'member' });
  mockRequireSessionOrIdToken.mockResolvedValue('user-member');
  mockAssertActiveUser.mockImplementation(async (uid: string) => {
    const data = store.get(`users/${uid}`);
    if (!data) {
      throw new Error(`missing test user ${uid}`);
    }
    return data;
  });
  mockAssertUserHasSiteAccess.mockResolvedValue({ siteId: 'site-1', siteData: {} });
});

describe('/api/keys POST', () => {
  it.each(['user', 'installer'] as const)(
    'rejects non-superadmin creation of %s scopes',
    async (resource) => {
      store.set('users/user-member', { role: 'member' });

      const res = await makePost({
        name: 'Platform key',
        environment: 'live',
        scopes: [{ resource, id: '*', permissions: ['admin'] }],
      });
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(body.code).toBe('forbidden');
      expect(body.detail).toBe(
        'superadmin access required to grant user or installer scopes',
      );
      expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(false);
    },
  );

  it('allows a superadmin to create superadmin-only scopes', async () => {
    mockRequireSessionOrIdToken.mockResolvedValue('user-superadmin');
    store.set('users/user-superadmin', { role: 'superadmin' });

    const scopes = [
      { resource: 'user', id: '*', permissions: ['read', 'admin'] },
      { resource: 'installer', id: '*', permissions: ['read', 'write', 'admin'] },
    ];

    const res = await makePost({
      name: 'Platform key',
      environment: 'live',
      scopes,
      ttlDays: 7,
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.key).toMatch(/^owk_live_/);
    expect(body.scopes).toEqual(scopes);

    const lookupRecord = Array.from(store.entries()).find(([p]) =>
      p.startsWith('api_keys/'),
    )?.[1];
    expect(lookupRecord).toMatchObject({
      userId: 'user-superadmin',
      keyId: body.keyId,
      environment: 'live',
      scopes,
      expiresAt: body.expiresAt,
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-superadmin',
        targetId: body.keyId,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/keys',
          method: 'POST',
          environment: 'live',
          keyPrefix: body.keyPrefix,
          scopeCount: 2,
          ttlDays: 7,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.key);
  });

  it('rejects concrete ids for superadmin-only scope resources', async () => {
    mockRequireSessionOrIdToken.mockResolvedValue('user-superadmin');
    store.set('users/user-superadmin', { role: 'superadmin' });

    const res = await makePost({
      name: 'Narrow platform key',
      environment: 'live',
      scopes: [{ resource: 'user', id: 'some-user', permissions: ['admin'] }],
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('validation_failed');
    expect(body.detail).toBe('user scopes must use id "*"');
  });

  it('still validates explicit site scopes against caller site access', async () => {
    const res = await makePost({
      name: 'Site key',
      // The shipped CLI and both SDKs still send it, so the route accepts and ignores it
      // rather than 400-ing.
      environment: 'test',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.environment).toBe('live');
    expect(body.scopes).toEqual([
      { resource: 'site', id: 'site-1', permissions: ['read'] },
    ]);
    expect(mockAssertUserHasSiteAccess).toHaveBeenCalledWith('user-member', 'site-1');
  });

  it.each(['chat', 'deploy'] as const)(
    'validates concrete %s scopes against caller site access',
    async (resource) => {
      const res = await makePost({
        name: 'Site-scoped key',
        environment: 'live',
        scopes: [{ resource, id: 'site-1', permissions: ['read'] }],
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.scopes).toEqual([{ resource, id: 'site-1', permissions: ['read'] }]);
      expect(mockAssertUserHasSiteAccess).toHaveBeenCalledWith('user-member', 'site-1');
    },
  );
});

describe('/api/keys plan gate', () => {
  const siteKey = {
    name: 'Site key',
    scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
  };

  beforeEach(enforcePlans);
  afterEach(stopEnforcingPlans);

  it('402s plan_required on the minting user’s free plan, and mints nothing', async () => {
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);

    const res = await makePost(siteKey);

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.api_keys',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('user-member');
    expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('mints on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);

    expect((await makePost(siteKey)).status).toBe(200);
  });

  it('keeps revoke open on free', async () => {
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);
    store.set('users/user-member/api_keys/key-a', { keyHash: 'hash-a', keyPrefix: 'owk_live_a' });
    store.set('api_keys/hash-a', { userId: 'user-member', keyId: 'key-a' });

    expect((await makeDelete('key-a')).status).toBe(200);
  });

  it('402s a rotation on free, since a rotation mints a fresh key', async () => {
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);
    store.set('users/user-member/api_keys/key-a', { keyHash: 'hash-a', keyPrefix: 'owk_live_a' });
    store.set('api_keys/hash-a', { userId: 'user-member', keyId: 'key-a' });

    const res = await makeRotate('key-a');

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'plan_required', entitlement: 'owlette.api_keys' });
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('/api/keys/{keyId} DELETE', () => {
  it('soft-revokes: both docs survive, each stamped with a numeric revokedAt', async () => {
    store.set('users/user-member/api_keys/key-a', {
      keyHash: 'hash-a',
      keyPrefix: 'owk_live_a',
    });
    store.set('api_keys/hash-a', { userId: 'user-member', keyId: 'key-a' });

    const res = await makeDelete('key-a');

    expect(res.status).toBe(200);

    const record = store.get('users/user-member/api_keys/key-a') as Record<string, unknown>;
    expect(record).not.toBeNull();
    expect(typeof record.revokedAt).toBe('number');

    // The lookup is the only doc the auth path reads, so the stamp has to reach
    // it — and its userId/keyId mapping has to survive, which is the whole point
    // of not deleting: a request replayed with a revoked key stays attributable.
    const lookup = store.get('api_keys/hash-a') as Record<string, unknown>;
    expect(typeof lookup.revokedAt).toBe('number');
    expect(lookup).toMatchObject({ userId: 'user-member', keyId: 'key-a' });

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-member',
        targetId: 'key-a',
        attributes: expect.objectContaining({
          verb: 'revoke',
          endpoint: '/api/keys/key-a',
          method: 'DELETE',
        }),
      }),
    );
  });

  it('still 200s when the lookup doc is absent — merge-set, never a batched update', async () => {
    // A batched update() against a missing document fails the ENTIRE commit with
    // NOT_FOUND, and old keys legitimately have no lookup doc. That failure mode
    // would leave the key neither revoked nor deleted — still authenticating —
    // while the ui toasted "key revoked".
    store.set('users/user-member/api_keys/key-a', { keyHash: 'hash-gone' });

    const res = await makeDelete('key-a');

    expect(res.status).toBe(200);
    const record = store.get('users/user-member/api_keys/key-a') as Record<string, unknown>;
    expect(typeof record.revokedAt).toBe('number');
    const lookup = store.get('api_keys/hash-gone') as Record<string, unknown>;
    expect(typeof lookup.revokedAt).toBe('number');
  });

  it('is idempotent — a second revoke keeps the first timestamp and emits nothing', async () => {
    const firstRevokedAt = 1_700_000_000_000;
    store.set('users/user-member/api_keys/key-a', {
      keyHash: 'hash-a',
      revokedAt: firstRevokedAt,
    });
    store.set('api_keys/hash-a', {
      userId: 'user-member',
      keyId: 'key-a',
      revokedAt: firstRevokedAt,
    });

    const res = await makeDelete('key-a');

    expect(res.status).toBe(200);
    // Re-stamping would rewrite the audit trail's answer to "when did this key
    // stop working", and nothing mutated, so nothing is emitted either.
    expect((store.get('users/user-member/api_keys/key-a') as { revokedAt: number }).revokedAt)
      .toBe(firstRevokedAt);
    expect((store.get('api_keys/hash-a') as { revokedAt: number }).revokedAt)
      .toBe(firstRevokedAt);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('404s for a key the caller does not own', async () => {
    expect((await makeDelete('key-missing')).status).toBe(404);
  });
});

describe('/api/keys/{keyId}/rotate POST', () => {
  it('audits successful key rotation without exposing raw key material', async () => {
    store.set('users/user-member/api_keys/key-old', {
      keyHash: 'hash-old',
      keyPrefix: 'owk_live_old',
      environment: 'live',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
      name: 'old key',
    });
    store.set('api_keys/hash-old', { userId: 'user-member', keyId: 'key-old' });

    const res = await makeRotate('key-old', { ttlDays: 14 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.key).toMatch(/^owk_live_/);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:user-member',
        targetId: body.keyId,
        attributes: expect.objectContaining({
          verb: 'rotate',
          endpoint: '/api/keys/key-old/rotate',
          method: 'POST',
          environment: 'live',
          keyPrefix: body.keyPrefix,
          rotatedFromKeyId: 'key-old',
          scopeCount: 1,
          ttlDays: 14,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(body.key);
  });

  it('rejects inactive users before rotating an api key', async () => {
    const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server') as {
      ApiAuthError: new (
        status: number,
        message: string,
        opts?: { code?: string; details?: Record<string, unknown> },
      ) => Error;
    };
    mockAssertActiveUser.mockRejectedValue(
      new ApiAuthError(403, 'Forbidden: User is deleted or inactive', {
        code: 'user_inactive',
      }),
    );

    const res = await makeRotate('key-old', { ttlDays: 14 });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('forbidden');
    expect(body.detail).toBe('Forbidden: User is deleted or inactive');
    expect(mockAssertActiveUser).toHaveBeenCalledWith('user-member');
    expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('/api/keys/{keyId} PATCH', () => {
  function seedKey(extra: Record<string, unknown> = {}) {
    store.set('users/user-member/api_keys/key-a', {
      keyHash: 'hash-a',
      keyPrefix: 'owk_live_aaa',
      environment: 'live',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
      name: 'original',
      expiresAt: Date.now() + 86_400_000,
      ...extra,
    });
    store.set('api_keys/hash-a', {
      userId: 'user-member',
      keyId: 'key-a',
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read'] }],
    });
  }

  it('writes the new scopes to the LOOKUP doc, not just the user record', async () => {
    // Authorization reads scopes only from api_keys/{keyHash} — updating the user doc alone
    // would leave the credential on its old permissions while the ui claimed otherwise.
    seedKey();
    const res = await makePatch('key-a', {
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read', 'write'] }],
    });
    expect(res.status).toBe(200);

    const lookup = store.get('api_keys/hash-a') as { scopes: unknown };
    expect(lookup.scopes).toEqual([
      { resource: 'site', id: 'site-1', permissions: ['read', 'write'] },
    ]);
    const record = store.get('users/user-member/api_keys/key-a') as { scopes: unknown };
    expect(record.scopes).toEqual(lookup.scopes);
  });

  it('renames without touching the lookup — name is display-only', async () => {
    seedKey();
    const res = await makePatch('key-a', { name: 'renamed' });
    expect(res.status).toBe(200);
    expect((store.get('users/user-member/api_keys/key-a') as { name: string }).name)
      .toBe('renamed');
    expect(store.get('api_keys/hash-a')).not.toHaveProperty('name');
  });

  it.each(['user', 'installer'] as const)(
    'refuses %s scopes for a non-superadmin — same gate as create',
    async (resource) => {
      seedKey();
      const res = await makePatch('key-a', {
        scopes: [{ resource, id: '*', permissions: ['admin'] }],
      });
      expect(res.status).toBe(403);
      // Unchanged on rejection.
      expect((store.get('api_keys/hash-a') as { scopes: unknown[] }).scopes).toHaveLength(1);
    },
  );

  it('409s on a revoked key', async () => {
    seedKey({ revokedAt: Date.now() - 1000 });
    const res = await makePatch('key-a', { name: 'nope' });
    expect(res.status).toBe(409);
  });

  it('409s on a rotated key — edit its successor instead', async () => {
    seedKey({ rotatedAt: Date.now() - 1000 });
    const res = await makePatch('key-a', { name: 'nope' });
    expect(res.status).toBe(409);
  });

  it('400s when nothing updatable was sent', async () => {
    seedKey();
    const res = await makePatch('key-a', {});
    expect(res.status).toBe(400);
  });

  it('400s on attempts to change environment or ttl', async () => {
    seedKey();
    expect((await makePatch('key-a', { environment: 'test' })).status).toBe(400);
    expect((await makePatch('key-a', { ttlDays: 30 })).status).toBe(400);
  });

  it('404s for a key the caller does not own', async () => {
    const res = await makePatch('key-missing', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('audits the edit with verb update and never the raw scopes', async () => {
    seedKey();
    await makePatch('key-a', {
      scopes: [{ resource: 'site', id: 'site-1', permissions: ['read', 'write'] }],
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        targetId: 'key-a',
        attributes: expect.objectContaining({ verb: 'update' }),
      }),
    );
    const payload = JSON.stringify(mockEmitMutation.mock.calls.at(-1));
    expect(payload).not.toContain('permissions');
    // Fingerprints are what keeps the redacted record auditable: they must actually differ,
    // or the event proves nothing.
    const attrs = mockEmitMutation.mock.calls.at(-1)?.[0].attributes as Record<string, unknown>;
    expect(attrs.scopeFingerprintBefore).toEqual(expect.any(String));
    expect(attrs.scopeFingerprintAfter).not.toEqual(attrs.scopeFingerprintBefore);
    expect(attrs.scopeCountAfter).toBe(1);
  });
});
