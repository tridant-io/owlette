/** @jest-environment node */

import { NextRequest } from 'next/server';

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

const mockRequireSessionOrIdToken = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockAssertUserHasSiteAccess = jest.fn();
const mockEmitMutation = jest.fn();

jest.mock('@/lib/auditLogClient', () => ({
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
    requireSessionOrIdToken: (...args: unknown[]) => mockRequireSessionOrIdToken(...args),
    assertActiveUser: (...args: unknown[]) => mockAssertActiveUser(...args),
    assertUserHasSiteAccess: (...args: unknown[]) => mockAssertUserHasSiteAccess(...args),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: jest.fn(() => ({ __op: 'serverTimestamp' })),
    delete: jest.fn(() => ({ __op: 'delete' })),
  },
}));

const mockTxGet = jest.fn();
const mockTxSet = jest.fn();
const mockTxUpdate = jest.fn();
const mockUserRoleDoc = jest.fn();
let mockDeviceCodeExists = true;
let mockDeviceCodeData: Record<string, unknown>;

function mockDocRef(collectionName: string, id: string): Record<string, unknown> {
  return {
    id,
    get: async () => {
      if (collectionName === 'users') return mockUserRoleDoc(id);
      return { exists: false, data: () => undefined };
    },
    collection: (name: string) => mockCollectionRef(`${collectionName}/${id}/${name}`),
  };
}

function mockCollectionRef(name: string): Record<string, unknown> {
  return {
    doc: (id: string) => mockDocRef(name, id),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockCollectionRef(name),
    runTransaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        get: mockTxGet,
        set: mockTxSet,
        update: mockTxUpdate,
      }),
  }),
}));

const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

import {
  enforcePlans,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  stopEnforcingPlans,
} from './helpers/planEnforcement';
import { POST } from '@/app/api/cli/device-code/authorize/route';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/cli/device-code/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireSessionOrIdToken.mockResolvedValue('user-1');
  mockAssertActiveUser.mockResolvedValue({ role: 'admin' });
  mockAssertUserHasSiteAccess.mockResolvedValue(undefined);
  mockUserRoleDoc.mockResolvedValue({
    exists: true,
    data: () => ({ role: 'admin' }),
  });
  mockDeviceCodeExists = true;
  mockDeviceCodeData = {
    status: 'pending',
    expiresAt: { toMillis: () => Date.now() + 60_000 },
    // v1 doc carrying the cli's polling secret — authorize will consume
    // and wipe this in the same transaction.
    wrapVersion: 'v1',
    deviceCode: 'a'.repeat(86),
  };
  mockTxGet.mockImplementation(async () => ({
    exists: mockDeviceCodeExists,
    data: () => mockDeviceCodeData,
  }));
});

describe('POST /api/cli/device-code/authorize', () => {
  it('authorizes a concrete chat scope after validating site access', async () => {
    const scopes = [{ resource: 'chat', id: 'site-1', permissions: ['read', 'write'] }];

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes,
        ttlDays: 30,
        environment: 'live',
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.keyId).toEqual(expect.any(String));
    expect(mockAssertUserHasSiteAccess).toHaveBeenCalledWith('user-1', 'site-1');
    expect(mockTxGet).toHaveBeenCalledTimes(1);
    expect(mockTxSet).toHaveBeenCalledTimes(2);
    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    const update = mockTxUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update).toMatchObject({
      status: 'authorized',
      authorizedBy: 'user-1',
      name: 'CLI',
      scopes,
      environment: 'live',
      siteId: 'site-1',
      wrapVersion: 'v1',
    });
    // v1: the raw key must not appear as plaintext in the firestore
    // write — it is wiped via FieldValue.delete() (the test mock
    // returns the sentinel {__op: 'delete'}). Only the encrypted blob
    // (opaque without the cli's deviceCode) survives.
    expect(update.rawKey).toEqual({ __op: 'delete' });
    expect(update.deviceCode).toEqual({ __op: 'delete' });
    expect(typeof update.encryptedCredentials).toBe('string');

    // Same row shape as POST /api/keys, plus the grant that distinguishes it.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0]![0] as {
      kind: string;
      siteId: string;
      actor: string;
      targetId: string;
      attributes: Record<string, unknown>;
    };
    expect(audit.kind).toBe('api_key_mutated');
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe('user:user-1');
    expect(audit.targetId).toBe(body.keyId);
    expect(audit.attributes).toMatchObject({
      verb: 'create',
      endpoint: '/api/cli/device-code/authorize',
      method: 'POST',
      environment: 'live',
      keyPrefix: body.keyPrefix,
      scopeCount: 1,
      ttlDays: 30,
      grant: 'cli_device_code',
    });
    // `keyPrefix` is the public 15-char handle the dashboard lists keys by —
    // the pairing phrase and the wrapped credentials stay out of the row.
    expect((audit.attributes.keyPrefix as string)).toHaveLength(15);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(update.encryptedCredentials as string);
    expect(serialized).not.toContain('pair-123');
  });

  it('falls back to plaintext rawKey for legacy (pre-v1) docs', async () => {
    // Doc without wrapVersion / deviceCode — represents a doc created
    // by an older deploy that is still mid-flight when the new
    // authorize handler runs.
    mockDeviceCodeData = {
      status: 'pending',
      expiresAt: { toMillis: () => Date.now() + 60_000 },
    };

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'chat', id: 'site-1', permissions: ['read'] }],
        environment: 'live',
      }),
    );
    expect(res.status).toBe(200);
    const update = mockTxUpdate.mock.calls[0]![1] as Record<string, unknown>;
    expect(update.rawKey).toMatch(/^owk_live_/);
    expect(update.encryptedCredentials).toBeUndefined();
    expect(update.wrapVersion).toBeUndefined();

    // Negative control with the raw key in hand: it must not appear anywhere in
    // the audit row, prefix aside.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockEmitMutation.mock.calls[0]![0])).not.toContain(
      update.rawKey as string,
    );
  });

  it('rejects an already authorised pairing phrase inside the transaction', async () => {
    mockDeviceCodeData = {
      status: 'authorized',
      expiresAt: { toMillis: () => Date.now() + 60_000 },
    };

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('pairing_phrase_already_authorized');
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('rejects inactive users before authorizing a device code', async () => {
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

    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'site', id: '*', permissions: ['read'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.code).toBe('forbidden');
    expect(body.detail).toBe('Forbidden: User is deleted or inactive');
    expect(mockAssertActiveUser).toHaveBeenCalledWith('user-1');
    expect(mockTxGet).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('rejects user scopes for non-superadmin signers', async () => {
    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'user', id: '*', permissions: ['admin'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(body.type).toBe('https://owlette.app/problems/forbidden');
    expect(body.code).toBe('forbidden');
    expect(body.detail).toBe(
      'superadmin access required to create user or installer scopes',
    );
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });

  it('rejects concrete installer scope ids', async () => {
    const res = await POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'installer', id: '2.11.0', permissions: ['admin'] }],
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect(body.type).toBe('https://owlette.app/problems/validation-failed');
    expect(body.code).toBe('validation_failed');
    expect(body.detail).toBe('installer scopes must use id "*"');
    expect(body.errors?.['body.scopes']).toContain('installer scope must use id "*"');
    expect(mockUserRoleDoc).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockTxUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/cli/device-code/authorize plan gate', () => {
  const authorize = () =>
    POST(
      request({
        code: 'PAIR-123',
        name: 'CLI',
        scopes: [{ resource: 'chat', id: 'site-1', permissions: ['read'] }],
      }),
    );

  beforeEach(enforcePlans);
  afterEach(stopEnforcingPlans);

  it('402s plan_required on the authorizing user’s free plan, and mints nothing', async () => {
    mockGetEntitlements.mockResolvedValue(FREE_ENTITLEMENTS);

    const res = await authorize();

    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: 'plan_required',
      entitlement: 'owlette.api_keys',
    });
    expect(mockGetEntitlements).toHaveBeenCalledWith('user-1');
    expect(mockTxGet).not.toHaveBeenCalled();
    expect(mockTxSet).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('authorizes on pro', async () => {
    mockGetEntitlements.mockResolvedValue(PRO_ENTITLEMENTS);

    expect((await authorize()).status).toBe(200);
    expect(mockTxSet).toHaveBeenCalledTimes(2);
  });
});
