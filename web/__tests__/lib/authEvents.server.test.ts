/** @jest-environment node */

const mockCreate = jest.fn();
const mockAdd = jest.fn();
const mockDoc = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({
      doc: (id: string) => ({
        collection: (sub: string) => ({
          doc: (docId: string) => {
            mockDoc(name, id, sub, docId);
            return { create: (...a: unknown[]) => mockCreate(...a) };
          },
          add: (...a: unknown[]) => mockAdd(...a),
        }),
      }),
    }),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'SERVER_TS' },
}));

jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: () => 'corr-1',
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...a: unknown[]) => mockLoggerError(...a) },
}));

import { NextRequest } from 'next/server';
import { recordAuthFailure, recordSecondFactorPassed, recordSignIn } from '@/lib/authEvents.server';

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/auth/session', { method: 'POST', headers });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(undefined);
  mockAdd.mockResolvedValue(undefined);
});

describe('recordSignIn', () => {
  it('writes an allow row in the decision-row layout under a deterministic id', async () => {
    const authTime = nowSeconds() - 5;
    const result = recordSignIn(request({ 'x-forwarded-for': '203.0.113.9' }), {
      userId: 'user-1',
      role: 'admin',
      method: 'google.com',
      authTime,
    });
    await flush();

    expect(result).toBeUndefined();
    expect(mockDoc).toHaveBeenCalledWith('global', 'audit_log', 'entries', `signin_user-1_${authTime}`);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      actor: { type: 'user', userId: 'user-1', role: 'admin' },
      capability: 'AUTH_SIGN_IN',
      target: { kind: 'user', id: 'user-1' },
      outcome: 'allow',
      metadata: {
        event: 'sign_in',
        method: 'google.com',
        network: { key: 'unknown', prefix: '203.0.113.0/24', viaEdge: false },
      },
      timestamp: 'SERVER_TS',
    });
  });

  it('writes nothing when the sign-in is more than 10 minutes old', async () => {
    recordSignIn(request(), { userId: 'user-1', role: 'member', method: 'password', authTime: nowSeconds() - 601 });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('writes nothing when auth_time is missing', async () => {
    recordSignIn(request(), {
      userId: 'user-1',
      role: 'member',
      method: 'password',
      authTime: undefined as unknown as number,
    });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('swallows ALREADY_EXISTS without logging', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('exists'), { code: 6 }));
    recordSignIn(request(), { userId: 'user-1', role: 'member', method: 'password', authTime: nowSeconds() });
    await flush();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('logs a write failure and does not throw', async () => {
    mockCreate.mockRejectedValue(new Error('firestore down'));
    expect(() =>
      recordSignIn(request(), { userId: 'user-1', role: 'member', method: 'password', authTime: nowSeconds() }),
    ).not.toThrow();
    await flush();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

describe('recordSecondFactorPassed', () => {
  it('writes an allow row with an auto id and the method', async () => {
    const result = recordSecondFactorPassed(request(), { userId: 'user-1', method: 'totp', role: 'admin' });
    await flush();

    expect(result).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      actor: { type: 'user', userId: 'user-1', role: 'admin' },
      capability: 'AUTH_SECOND_FACTOR',
      target: { kind: 'user', id: 'user-1' },
      outcome: 'allow',
      metadata: {
        event: 'second_factor_passed',
        method: 'totp',
        network: { key: 'unknown', prefix: null, viaEdge: false },
      },
      timestamp: 'SERVER_TS',
    });
  });

  it('defaults the role to member, logs a write failure and does not throw', async () => {
    mockAdd.mockRejectedValue(new Error('firestore down'));
    expect(() => recordSecondFactorPassed(request(), { userId: 'user-1', method: 'passkey' })).not.toThrow();
    await flush();
    expect(mockAdd.mock.calls[0][0].actor.role).toBe('member');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});

describe('recordAuthFailure', () => {
  it('writes a deny row with an auto id, the reason and the method', async () => {
    const result = recordAuthFailure(request(), {
      userId: 'user-1',
      capability: 'AUTH_SECOND_FACTOR',
      event: 'second_factor_failed',
      reason: 'invalid_totp_code',
      method: 'totp',
    });
    await flush();

    expect(result).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith({
      correlationId: 'corr-1',
      actor: { type: 'user', userId: 'user-1', role: 'member' },
      capability: 'AUTH_SECOND_FACTOR',
      target: { kind: 'user', id: 'user-1' },
      outcome: 'deny',
      denyReason: 'invalid_totp_code',
      metadata: {
        event: 'second_factor_failed',
        method: 'totp',
        network: { key: 'unknown', prefix: null, viaEdge: false },
      },
      timestamp: 'SERVER_TS',
    });
  });

  it('carries the role it is given and omits a method it is not given', async () => {
    recordAuthFailure(request(), {
      userId: 'user-1',
      capability: 'AUTH_SIGN_IN',
      event: 'sign_in_failed',
      reason: 'user_deleted',
      role: 'superadmin',
    });
    await flush();

    const row = mockAdd.mock.calls[0][0];
    expect(row.actor.role).toBe('superadmin');
    expect(row.metadata).not.toHaveProperty('method');
  });

  it('logs a write failure and does not throw', async () => {
    mockAdd.mockRejectedValue(new Error('firestore down'));
    expect(() =>
      recordAuthFailure(request(), {
        userId: 'user-1',
        capability: 'AUTH_SIGN_IN',
        event: 'sign_in_failed',
        reason: 'user_deleted',
      }),
    ).not.toThrow();
    await flush();
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });
});
