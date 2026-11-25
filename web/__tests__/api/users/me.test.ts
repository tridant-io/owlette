/** @jest-environment node */

import crypto from 'crypto';
import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockLoggerError = jest.fn();
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

const mockRequireSessionOrIdToken = jest.fn();
jest.mock('@/lib/apiAuth.server', () => ({
  ApiAuthError: class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  requireSessionOrIdToken: (...args: unknown[]) =>
    mockRequireSessionOrIdToken(...args),
}));

const mockSecurityRead = jest.fn();
jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: (...args: unknown[]) => mockSecurityRead(...args),
  },
}));

const mockDeleteOwnAccount = jest.fn();
jest.mock('@/lib/actions/deleteOwnAccount.server', () => ({
  deleteOwnAccount: (...args: unknown[]) => mockDeleteOwnAccount(...args),
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr_self_delete',
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TIMESTAMP__',
  },
}));

let userDoc:
  | { exists: true; data: Record<string, unknown> }
  | { exists: false; data?: undefined };
let auditWrites: Record<string, unknown>[];
let auditSetFailure: Error | null;

function mockMakeDocRef(path: string): Record<string, unknown> {
  return {
    path,
    collection: (name: string) => mockMakeCollectionRef(`${path}/${name}`),
    get: jest.fn(async () => {
      if (path === 'users/user-1') {
        return {
          exists: userDoc.exists,
          data: () => (userDoc.exists ? userDoc.data : undefined),
        };
      }
      return { exists: false, data: () => undefined };
    }),
    set: jest.fn(async (payload: Record<string, unknown>) => {
      if (path.startsWith('global/audit_log/entries/')) {
        if (auditSetFailure) throw auditSetFailure;
        auditWrites.push(payload);
      }
    }),
  };
}

function mockMakeCollectionRef(path: string): Record<string, unknown> {
  return {
    doc: (id?: string) => mockMakeDocRef(`${path}/${id ?? 'auto_audit_id'}`),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => mockMakeCollectionRef(name),
  }),
}));

import { DELETE } from '@/app/api/users/me/route';

function request(
  url = 'http://localhost/api/users/me',
  init: RequestInit = {},
) {
  const { signal, ...rest } = init ?? {};
  return new NextRequest(url, {
    method: 'DELETE',
    ...rest,
    ...(signal ? { signal } : {}),
  });
}

function operationIdFor(userId: string, key?: string): string {
  const source = key ? `${userId}:${key}` : `account-self-delete:${userId}`;
  return crypto.createHash('sha256').update(source).digest('hex');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoggerError.mockClear();
  userDoc = {
    exists: true,
    data: { role: 'member', sites: ['site-a', 'site-b'] },
  };
  auditWrites = [];
  auditSetFailure = null;
  mockRequireSessionOrIdToken.mockResolvedValue('user-1');
  mockSecurityRead.mockResolvedValue({
    capability_enforcement: true,
    rate_limit_enforcement: true,
  });
  mockDeleteOwnAccount.mockResolvedValue({
    userId: 'user-1',
    operationId: operationIdFor('user-1', 'idem-1'),
    correlationId: 'corr_self_delete',
    performed: false,
    alreadyCompleted: false,
    dryRun: true,
    sites: ['site-a'],
    deletedCounts: {
      machines: 2,
      deployments: 1,
      logs: 3,
      sites: 1,
      users: 1,
    },
    deletedPaths: [
      'sites/site-a/machines/m1',
      'sites/site-a/deployments/d1',
      'sites/site-a/logs/l1',
      'sites/site-a',
      'users/user-1',
    ],
  });
});

describe('DELETE /api/users/me', () => {
  it('refuses a session or id token still owing its second factor, and deletes nothing', async () => {
    const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server') as {
      ApiAuthError: new (status: number, message: string) => Error;
    };
    mockRequireSessionOrIdToken.mockRejectedValueOnce(
      Object.assign(new ApiAuthError(403, 'complete two-factor verification first'), {
        code: 'mfa_challenge_required',
      }),
    );
    const res = await DELETE(
      request('http://localhost/api/users/me', {
        headers: { 'Idempotency-Key': 'idem-mfa' },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockDeleteOwnAccount).not.toHaveBeenCalled();
    // no second argument: nothing here opts in to the pre-mfa path
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledWith(expect.anything());
  });

  it('runs a dry-run self-delete and audits per-path counts', async () => {
    const res = await DELETE(
      request('http://localhost/api/users/me?dryRun=true', {
        headers: { 'Idempotency-Key': 'idem-1' },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.deletedCounts).toEqual({
      machines: 2,
      deployments: 1,
      logs: 3,
      sites: 1,
      users: 1,
    });
    expect(mockDeleteOwnAccount).toHaveBeenCalledWith({
      userId: 'user-1',
      dryRun: true,
      operationId: operationIdFor('user-1', 'idem-1'),
    });
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      correlationId: 'corr_self_delete',
      actor: { type: 'user', userId: 'user-1', role: 'member' },
      capability: 'USER_SELF_DELETE',
      target: { kind: 'user', id: 'user-1' },
      outcome: 'allow',
      metadata: expect.objectContaining({
        dryRun: true,
        deletedCounts: {
          machines: 2,
          deployments: 1,
          logs: 3,
          sites: 1,
          users: 1,
        },
      }),
    });
  });

  it('allows member self-delete, proving this is not platform-admin gated', async () => {
    mockDeleteOwnAccount.mockResolvedValueOnce({
      userId: 'user-1',
      operationId: operationIdFor('user-1'),
      performed: true,
      alreadyCompleted: false,
      dryRun: false,
      sites: [],
      deletedCounts: {
        machines: 0,
        deployments: 0,
        logs: 0,
        sites: 0,
        users: 1,
      },
      deletedPaths: ['users/user-1'],
    });

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.performed).toBe(true);
    expect(mockRequireSessionOrIdToken).toHaveBeenCalledTimes(1);
    expect(mockDeleteOwnAccount).toHaveBeenCalledWith({
      userId: 'user-1',
      dryRun: false,
      operationId: operationIdFor('user-1'),
    });
  });

  it('rejects api keys before the cascade runs', async () => {
    const res = await DELETE(
      request('http://localhost/api/users/me', {
        headers: { 'x-api-key': 'owk_live_secret' },
      }),
    );

    expect(res.status).toBe(401);
    expect(mockRequireSessionOrIdToken).not.toHaveBeenCalled();
    expect(mockDeleteOwnAccount).not.toHaveBeenCalled();
    expect(auditWrites).toEqual([]);
  });

  it('returns 503 when the blocking allow-audit write fails', async () => {
    auditSetFailure = new Error('audit unavailable');

    const res = await DELETE(request());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.detail).toContain('audit log unavailable');
    expect(mockDeleteOwnAccount).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalled();
  });
});
