/** @jest-environment node */

/**
 * `web/app/api/platform/security/kill-switch/route.ts`: superadmin writes
 * `global/security_config` with `flippedBy`/`reason`/`expiresAt`; everyone else
 * gets 403; missing/invalid flag, missing reason and out-of-range
 * expiresInMinutes are rejected; the wrapper's audit entry lands.
 */

const securitySetCalls: Array<{ payload: Record<string, unknown>; opts?: unknown }> = [];
const auditSetCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];

let userRole: 'superadmin' | 'admin' | 'member' = 'superadmin';

jest.mock('@/lib/firebase-admin', () => {
  const buildDoc = (path: string): unknown => ({
    collection: (sub: string) => buildCol(`${path}/${sub}`),
    get: () => {
      if (path.startsWith('users/')) {
        return Promise.resolve({ exists: true, data: () => ({ role: userRole, sites: [] }) });
      }
      return Promise.resolve({ exists: false, data: () => undefined });
    },
    set: (payload: Record<string, unknown>, opts?: unknown) => {
      if (path === 'global/security_config') {
        securitySetCalls.push({ payload, opts });
      } else if (path.startsWith('global/audit_log/entries/')) {
        auditSetCalls.push({ path, payload });
      }
      return Promise.resolve();
    },
  });
  const buildCol = (path: string): unknown => ({
    doc: (id?: string) => buildDoc(`${path}/${id ?? 'auto'}`),
  });
  return {
    getAdminDb: () => ({
      collection: (top: string) => buildCol(top),
    }),
  };
});

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: { now: () => ({ toMillis: () => 0 }) },
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
      lastUpdated: 0,
      expiresAt: 0,
    })),
  },
}));

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
}));

let resolveAuthUserId = 'uid_super';
jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthErrorMock extends Error {
    status: number;
    code?: string;
    details?: Record<string, unknown>;
    constructor(status: number, message: string, opts?: { code?: string; details?: Record<string, unknown> }) {
      super(message);
      this.status = status;
      this.code = opts?.code;
      this.details = opts?.details;
    }
  }
  return {
    ApiAuthError: ApiAuthErrorMock,
    resolveAuth: jest.fn(async () => ({ userId: resolveAuthUserId, keyContext: null })),
    requireScope: jest.fn(() => ({ isLegacy: false })),
    assertUserHasSiteAccess: jest.fn(async () => ({ siteId: '', siteData: {}, machineIds: null })),
  };
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: () => {}, info: () => {}, warn: jest.fn(), error: jest.fn() },
}));

import { POST } from '@/app/api/platform/security/kill-switch/route';
import { NextRequest } from 'next/server';

beforeEach(() => {
  securitySetCalls.length = 0;
  auditSetCalls.length = 0;
  userRole = 'superadmin';
  resolveAuthUserId = 'uid_super';
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/platform/security/kill-switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/platform/security/kill-switch — happy path', () => {
  it('superadmin: writes the flag with flippedBy/reason/expiresAt and 4h default expiry', async () => {
    const before = Date.now();
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: 'investigating capability matrix bug',
    }));
    const after = Date.now();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.flag).toBe('capability_enforcement');
    expect(json.enabled).toBe(false);

    expect(securitySetCalls).toHaveLength(1);
    const call = securitySetCalls[0];
    expect(call.payload.capability_enforcement).toBe(false);
    expect(call.payload.capability_enforcement_flippedBy).toBe('uid_super');
    expect(call.payload.capability_enforcement_reason).toBe('investigating capability matrix bug');
    const expiresAt = call.payload.capability_enforcement_expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    const expiresMs = expiresAt.getTime();
    // ~4h ahead of now, with slack for slow CI.
    expect(expiresMs).toBeGreaterThanOrEqual(before + 4 * 60 * 60 * 1000 - 5_000);
    expect(expiresMs).toBeLessThanOrEqual(after + 4 * 60 * 60 * 1000 + 5_000);
    expect(call.opts).toEqual({ merge: true });

    expect(auditSetCalls.length).toBeGreaterThanOrEqual(1);
    expect(auditSetCalls.some((c) => (c.payload as { outcome?: string }).outcome === 'allow')).toBe(true);
  });

  it('honors a custom expiresInMinutes', async () => {
    const before = Date.now();
    const res = await POST(makeRequest({
      flag: 'rate_limit_enforcement',
      enabled: false,
      reason: 'shadow mode',
      expiresInMinutes: 30,
    }));
    expect(res.status).toBe(200);
    const expiresAt = securitySetCalls[0].payload.rate_limit_enforcement_expiresAt as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 5_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000 + 5_000);
  });
});

describe('POST /api/platform/security/kill-switch — auth gating', () => {
  it('non-superadmin rejected with 403', async () => {
    userRole = 'admin';
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: 'attempt',
    }));
    expect(res.status).toBe(403);
    expect(securitySetCalls).toHaveLength(0);
  });

  it('member rejected with 403', async () => {
    userRole = 'member';
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: 'attempt',
    }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/platform/security/kill-switch — validation', () => {
  it('rejects missing flag', async () => {
    const res = await POST(makeRequest({ enabled: false, reason: 'x' }));
    expect(res.status).toBe(400);
    expect(securitySetCalls).toHaveLength(0);
  });

  it('rejects unknown flag', async () => {
    const res = await POST(makeRequest({ flag: 'bogus', enabled: false, reason: 'x' }));
    expect(res.status).toBe(400);
  });

  it('rejects non-boolean enabled', async () => {
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: 'no',
      reason: 'x',
    }));
    expect(res.status).toBe(400);
  });

  it('rejects empty reason', async () => {
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: '',
    }));
    expect(res.status).toBe(400);
  });

  it('rejects out-of-range expiresInMinutes', async () => {
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: 'x',
      expiresInMinutes: -1,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects expiresInMinutes above the max', async () => {
    const res = await POST(makeRequest({
      flag: 'capability_enforcement',
      enabled: false,
      reason: 'x',
      expiresInMinutes: 1_000_000,
    }));
    expect(res.status).toBe(400);
  });

  it('rejects malformed json body', async () => {
    const req = new NextRequest('http://localhost/api/platform/security/kill-switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
