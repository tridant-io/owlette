/** @jest-environment node */

import { NextRequest } from 'next/server';
import { ProblemType } from '@/lib/apiErrors';

const store = new Map<string, Record<string, unknown> | null>();
let mockKeyContext: { keyId?: string; scopes?: unknown[] | null } | null = null;
let collectionGetError: Error | null = null;
let consoleErrorSpy: jest.SpyInstance;
const mockEmitMutation = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

jest.mock('@/lib/authorizedHandler.server', () => ({
  authorizedPlatformHandler: () => (handler: (...args: unknown[]) => unknown) =>
    (request: NextRequest, routeContext?: unknown) =>
      handler(
        request,
        {
          actor: { type: 'user', userId: 'test-admin', role: 'superadmin', siteRoles: {} },
          correlationId: 'corr-test',
          auth: { userId: 'test-admin', keyContext: mockKeyContext },
          scopeCheck: { isLegacy: false },
        },
        routeContext,
      ),
}));

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

function collectionRef(parts: string[], filters: Array<[string, unknown]> = []) {
  const path = collectionPath(parts);
  const ref = {
    doc: (id: string) => docRef([...parts, id]),
    collection: (name: string) => collectionRef([...parts, name]),
    orderBy: () => ref,
    // Equality-only `where`, enough for the account billing gate's
    // `sites where owner == uid` lookup. Filters accumulate so chaining works.
    where: (field: string, _op: string, value: unknown) =>
      collectionRef(parts, [...filters, [field, value]]),
    get: async () => {
      if (collectionGetError) throw collectionGetError;
      return {
        docs: Array.from(store.entries())
          .filter(([docPath, data]) => data && docPath.startsWith(`${path}/`))
          .filter(([, data]) =>
            filters.every(([field, value]) => (data as Record<string, unknown>)[field] === value),
          )
          .map(([docPath, data]) => ({
            id: docPath.slice(path.length + 1).split('/')[0],
            data: () => data,
          })),
      };
    },
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
  stopEnforcingPlans,
} from '../helpers/planEnforcement';
import { GET, POST } from '@/app/api/account/api-keys/route';
import { DELETE } from '@/app/api/account/api-keys/[keyId]/route';

beforeEach(() => {
  store.clear();
  mockKeyContext = null;
  collectionGetError = null;
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('/api/account/api-keys', () => {
  it('lists API key metadata for the authenticated account', async () => {
    store.set('users/test-admin/api_keys/key-a', {
      name: 'CI',
      keyPrefix: 'owk_live_abc123',
      environment: 'live',
      scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
      expiresAt: 456,
      createdAt: 123,
      lastUsedAt: null,
    });

    const res = await GET(new NextRequest('http://localhost/api/account/api-keys'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      success: true,
      keys: [{
        id: 'key-a',
        name: 'CI',
        keyPrefix: 'owk_live_abc123',
        environment: 'live',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
        expiresAt: 456,
      }],
    });
  });

  it('returns problem+json when key listing fails unexpectedly', async () => {
    collectionGetError = new Error('firestore unavailable');

    const res = await GET(new NextRequest('http://localhost/api/account/api-keys'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(body).toMatchObject({
      type: ProblemType.Internal,
      title: 'internal error',
      status: 500,
      code: 'internal_error',
      docsUrl: 'https://owlette.app/docs/api/errors#internal_error',
      instance: 'account/api-keys',
    });
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'));
  });

  it('creates a key and returns the raw key once', async () => {
    const res = await POST(new NextRequest('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deploy' }),
    }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.name).toBe('Deploy');
    expect(json.key).toMatch(/^owk_live_/);
    expect(json.environment).toBe('live');
    expect(json.keyPrefix).toBe(json.key.slice(0, 15));
    expect(json.expiresAt).toEqual(expect.any(Number));
    expect(json.scopes).toEqual(
      expect.arrayContaining([
        {
          resource: 'user',
          id: '*',
          permissions: ['read', 'write', 'deploy', 'rollback', 'admin'],
        },
        {
          resource: 'installer',
          id: '*',
          permissions: ['read', 'write', 'deploy', 'rollback', 'admin'],
        },
      ]),
    );

    const userRecord = Array.from(store.entries()).find(([p]) =>
      p.startsWith('users/test-admin/api_keys/'),
    )?.[1];
    expect(userRecord).toMatchObject({
      name: 'Deploy',
      keyPrefix: json.keyPrefix,
      environment: 'live',
      scopes: json.scopes,
      expiresAt: json.expiresAt,
    });

    const lookupRecord = Array.from(store.entries()).find(([p]) =>
      p.startsWith('api_keys/'),
    )?.[1];
    expect(lookupRecord).toMatchObject({
      userId: 'test-admin',
      keyId: json.keyId,
      environment: 'live',
      scopes: json.scopes,
      expiresAt: json.expiresAt,
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:test-admin',
        targetId: json.keyId,
        attributes: expect.objectContaining({
          verb: 'create',
          endpoint: '/api/account/api-keys',
          method: 'POST',
          environment: 'live',
          keyPrefix: json.keyPrefix,
          inheritedFromCallerKey: false,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(json.key);
  });

  it('carries forward scoped API-key caller scopes instead of widening', async () => {
    const callerScopes = [
      { resource: 'site', id: 'site-1', permissions: ['read'] },
    ];
    mockKeyContext = { scopes: callerScopes };

    const res = await POST(new NextRequest('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Child key' }),
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.scopes).toEqual(callerScopes);
    expect(json.scopes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: 'user' }),
        expect.objectContaining({ resource: 'installer' }),
      ]),
    );

    const lookupRecord = Array.from(store.entries()).find(([p]) =>
      p.startsWith('api_keys/'),
    )?.[1];
    expect(lookupRecord).toMatchObject({ scopes: callerScopes });
  });

  it('audits child-key creation under the caller API key actor', async () => {
    const callerScopes = [
      { resource: 'site', id: 'site-1', permissions: ['read'] },
    ];
    mockKeyContext = { keyId: 'parent-key', scopes: callerScopes };

    const res = await POST(new NextRequest('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Child key' }),
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        actor: 'apiKey:parent-key',
        targetId: json.keyId,
        attributes: expect.objectContaining({
          verb: 'create',
          inheritedFromCallerKey: true,
        }),
      }),
    );
    expect(JSON.stringify(mockEmitMutation.mock.calls)).not.toContain(json.key);
  });
});

describe('/api/account/api-keys plan gate', () => {
  const create = () =>
    POST(new NextRequest('http://localhost/api/account/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Deploy' }),
    }));

  beforeEach(() => {
    enforcePlans();
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);
  });
  afterEach(stopEnforcingPlans);

  it('402s plan_required on the minting user’s free plan, and mints nothing', async () => {
    store.set('users/test-admin', { role: 'user' });

    const res = await create();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.api_keys',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('test-admin');
    expect(Array.from(store.keys()).some((p) => p.startsWith('api_keys/'))).toBe(false);
  });

  it('mints for a superadmin, whatever tridant says', async () => {
    store.set('users/test-admin', { role: 'superadmin' });

    expect((await create()).status).toBe(200);
  });
});

describe('/api/account/api-keys/{keyId}', () => {
  function revoke(keyId: string) {
    return DELETE(
      new NextRequest(`http://localhost/api/account/api-keys/${keyId}`, { method: 'DELETE' }),
      { params: Promise.resolve({ keyId }) },
    );
  }

  it('soft-revokes by path id: both docs survive with a numeric revokedAt', async () => {
    // The forgotten second copy of the revoke path. It must behave identically to
    // DELETE /api/keys/{keyId} — the two drifted apart once already.
    store.set('users/test-admin/api_keys/key-a', {
      keyHash: 'hash-a',
      name: 'CI',
    });
    store.set('api_keys/hash-a', { userId: 'test-admin', keyId: 'key-a' });

    const res = await revoke('key-a');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const record = store.get('users/test-admin/api_keys/key-a') as Record<string, unknown>;
    expect(record).not.toBeNull();
    expect(typeof record.revokedAt).toBe('number');

    const lookup = store.get('api_keys/hash-a') as Record<string, unknown>;
    expect(typeof lookup.revokedAt).toBe('number');
    expect(lookup).toMatchObject({ userId: 'test-admin', keyId: 'key-a' });

    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'api_key_mutated',
        siteId: '',
        actor: 'user:test-admin',
        targetId: 'key-a',
        attributes: expect.objectContaining({
          verb: 'revoke',
          endpoint: '/api/account/api-keys/key-a',
          method: 'DELETE',
        }),
      }),
    );
  });

  it('still 200s when the lookup doc is absent — merge-set, never a batched update', async () => {
    // A batched update() against a missing document fails the ENTIRE commit with
    // NOT_FOUND, leaving the key neither revoked nor deleted.
    store.set('users/test-admin/api_keys/key-a', { keyHash: 'hash-gone' });

    const res = await revoke('key-a');

    expect(res.status).toBe(200);
    expect(
      typeof (store.get('users/test-admin/api_keys/key-a') as Record<string, unknown>).revokedAt,
    ).toBe('number');
    expect(typeof (store.get('api_keys/hash-gone') as Record<string, unknown>).revokedAt).toBe(
      'number',
    );
  });

  it('is idempotent — a second revoke keeps the first timestamp and emits nothing', async () => {
    const firstRevokedAt = 1_700_000_000_000;
    store.set('users/test-admin/api_keys/key-a', {
      keyHash: 'hash-a',
      revokedAt: firstRevokedAt,
    });
    store.set('api_keys/hash-a', {
      userId: 'test-admin',
      keyId: 'key-a',
      revokedAt: firstRevokedAt,
    });

    const res = await revoke('key-a');

    expect(res.status).toBe(200);
    expect((store.get('users/test-admin/api_keys/key-a') as { revokedAt: number }).revokedAt).toBe(
      firstRevokedAt,
    );
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('returns problem+json when revoking an unknown key', async () => {
    const res = await revoke('missing-key');
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json; charset=utf-8');
    expect(body).toMatchObject({
      type: ProblemType.NotFound,
      title: 'not found',
      status: 404,
      code: 'not_found',
      docsUrl: 'https://owlette.app/docs/api/errors#not_found',
      detail: 'API key not found',
    });
    expect(body.requestId).toBe(res.headers.get('X-Request-Id'));
  });
});
