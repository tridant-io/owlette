/** @jest-environment node */

/**
 * Second-factor codes: one attempt budget per account, whatever ip the attempts
 * come from, and a totp code is good for one sign-in or proof only. Runs the real
 * limiter (its in-memory fallback, since jest has no redis) and the real
 * transaction that records the spent time step.
 */

const mockRequirePreMfaSessionUser = jest.fn();
const mockRequirePreMfaSession = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockMarkSessionMfaDisabled = jest.fn();
const mockApplyMfaFactorChange = jest.fn();

/** code → the time step it belongs to; anything else is wrong. */
const codeSteps = new Map<string, number>();

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

// the ip limiter wrapper is not under test: the per-account budget is
jest.mock('@/lib/withRateLimit', () => ({
  ...jest.requireActual('@/lib/withRateLimit'),
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiAuthError,
    assertActiveUser: (...a: unknown[]) => mockAssertActiveUser(...a),
    requirePreMfaSessionUser: (...a: unknown[]) => mockRequirePreMfaSessionUser(...a),
    requirePreMfaSession: (...a: unknown[]) => mockRequirePreMfaSession(...a),
  };
});

jest.mock('@/lib/totp', () => ({
  verifyTOTP: (code: string) => codeSteps.has(code),
  totpStep: (code: string) => codeSteps.get(code) ?? null,
  verifyBackupCode: (code: string, hash: string) => hash === `hash-${code}`,
}));

jest.mock('@/lib/encryption.server', () => ({
  decrypt: (s: string) => s,
  isEncryptionConfigured: () => true,
}));

jest.mock('@/lib/sessionManager.server', () => ({
  markSessionMfaVerified: (...a: unknown[]) => mockMarkSessionMfaVerified(...a),
  markSessionMfaDisabled: (...a: unknown[]) => mockMarkSessionMfaDisabled(...a),
}));

jest.mock('@/lib/deviceTrust.server', () => ({
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  mintDeviceTrustToken: () => ({ raw: 'raw', hash: 'hash' }),
  createTrustedDevice: jest.fn(),
  revokeAllTrustedDevices: jest.fn().mockResolvedValue(0),
  deviceTrustCookieOptions: () => ({ httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 1 }),
}));

jest.mock('@/lib/mfaFactors.server', () => ({
  applyMfaFactorChange: (...a: unknown[]) => mockApplyMfaFactorChange(...a),
}));
jest.mock('@/lib/mfaNotice.server', () => ({ sendMfaFactorNotice: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__DELETE__', serverTimestamp: () => '__TS__' },
}));
jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'localhost',
  getExpectedOrigins: () => ['http://localhost:3000'],
  getAndDeleteChallenge: jest.fn(),
  getUserPasskeys: jest.fn(),
  updatePasskeyCounter: jest.fn(),
}));

/** users/{uid} docs, read and written through a fake that runs transactions serially. */
const users = new Map<string, Record<string, unknown>>();

jest.mock('@/lib/firebase-admin', () => {
  const ref = (uid: string) => ({ id: uid, get: async () => snap(uid) });
  const snap = (uid: string) => ({
    exists: users.has(uid),
    data: () => (users.has(uid) ? { ...users.get(uid) } : undefined),
  });
  const merge = (uid: string, payload: Record<string, unknown>) =>
    users.set(uid, { ...(users.get(uid) ?? {}), ...payload });
  return {
    getAdminDb: () => ({
      collection: () => ({ doc: (uid: string) => ref(uid) }),
      runTransaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
        cb({
          get: async (r: { id: string }) => snap(r.id),
          update: (r: { id: string }, payload: Record<string, unknown>) => merge(r.id, payload),
          set: (r: { id: string }, payload: Record<string, unknown>) => merge(r.id, payload),
        }),
    }),
  };
});

import { POST as verifyLogin } from '@/app/api/mfa/verify-login/route';
import { POST as disable } from '@/app/api/mfa/disable/route';
import { verifyMfaProof } from '@/lib/mfaProof.server';
import { createMockRequest } from '../helpers/utils';

function enroll(uid: string) {
  users.set(uid, {
    email: `${uid}@example.com`,
    mfaEnrolled: true,
    mfaSecret: 'PLAINSECRET',
    backupCodes: ['hash-BACKUP-1', 'hash-BACKUP-2'],
  });
}

function signInCode(uid: string, code: string, ip: string, isBackupCode = false) {
  return verifyLogin(
    createMockRequest('http://localhost/api/mfa/verify-login', {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
      body: { userId: uid, code, isBackupCode },
    }),
  );
}

let nextUid = 0;
/** a new account per test: the in-memory budget outlives a test. */
function freshUser(): string {
  const uid = `user-${++nextUid}`;
  enroll(uid);
  return uid;
}

beforeEach(() => {
  codeSteps.clear();
  codeSteps.set('111111', 1000);
  codeSteps.set('222222', 1001);
  mockRequirePreMfaSessionUser.mockImplementation(async (_req: unknown, uid: string) => uid);
  mockAssertActiveUser.mockImplementation(async (uid: string) => ({ ...users.get(uid) }));
  mockApplyMfaFactorChange.mockResolvedValue({
    factors: { totp: false, passkeys: 0 },
    mfaEnrolled: false,
    requiresMfaSetup: true,
  });
});

describe('the attempt budget is per account', () => {
  it('locks the account out across ips, and keeps the lock for a right code', async () => {
    const uid = freshUser();
    let attempts = 0;
    let res = await signInCode(uid, '000000', '198.51.100.0');
    while (res.status === 400 && attempts < 100) {
      attempts += 1;
      // every wrong guess comes from a new address
      res = await signInCode(uid, '000000', `198.51.100.${attempts}`);
    }
    expect(res.status).toBe(429);
    expect(attempts).toBeLessThan(100);
    // the same code every route that spends the budget answers with
    expect(await res.json()).toMatchObject({ code: 'mfa_attempts_exceeded' });

    // the right code, from yet another address, is still refused
    const right = await signInCode(uid, '111111', '203.0.113.7');
    expect(right.status).toBe(429);
    // and so is a backup code: they spend the same budget
    const backup = await signInCode(uid, 'BACKUP-1', '203.0.113.8', true);
    expect(backup.status).toBe(429);
    expect(users.get(uid)?.backupCodes).toEqual(['hash-BACKUP-1', 'hash-BACKUP-2']);

    // another account on the same address is untouched
    const other = freshUser();
    expect((await signInCode(other, '111111', '203.0.113.7')).status).toBe(200);
  });

  it('counts the codes /api/mfa/disable checks against the same budget', async () => {
    const uid = freshUser();
    mockRequirePreMfaSession.mockResolvedValue(uid);
    let res = await signInCode(uid, '000000', '198.51.100.0');
    for (let i = 1; res.status === 400 && i < 100; i++) {
      res = await signInCode(uid, '000000', `198.51.100.${i}`);
    }
    expect(res.status).toBe(429);

    const off = await disable(
      createMockRequest('http://localhost/api/mfa/disable', { method: 'POST', body: { code: '111111' } }),
    );
    expect(off.status).toBe(429);
    expect(await off.json()).toMatchObject({ code: 'mfa_attempts_exceeded' });
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });

  it('counts a totp or backup-code proof against the same budget', async () => {
    const uid = freshUser();
    let outcome = await verifyMfaProof(uid, { kind: 'totp', code: '000000' }, users.get(uid)!);
    for (let i = 0; !outcome.ok && outcome.status === 400 && i < 100; i++) {
      outcome = await verifyMfaProof(uid, { kind: 'totp', code: '000000' }, users.get(uid)!);
    }
    expect(outcome).toMatchObject({ ok: false, status: 429 });
    expect(
      await verifyMfaProof(uid, { kind: 'backup_code', code: 'BACKUP-1' }, users.get(uid)!),
    ).toMatchObject({ ok: false, status: 429 });
  });
});

describe('a totp code is spent once', () => {
  it('refuses the same code a second time at sign-in, and takes the next one', async () => {
    const uid = freshUser();
    expect((await signInCode(uid, '111111', '198.51.100.1')).status).toBe(200);
    expect((await signInCode(uid, '111111', '198.51.100.2')).status).toBe(400);
    expect((await signInCode(uid, '222222', '198.51.100.3')).status).toBe(200);
    // and an earlier step, after a later one, is refused too
    codeSteps.set('333333', 999);
    expect((await signInCode(uid, '333333', '198.51.100.4')).status).toBe(400);
  });

  it('refuses a code spent at sign-in when it is replayed to remove the authenticator app', async () => {
    const uid = freshUser();
    mockRequirePreMfaSession.mockResolvedValue(uid);
    expect((await signInCode(uid, '111111', '198.51.100.1')).status).toBe(200);

    const replay = await disable(
      createMockRequest('http://localhost/api/mfa/disable', { method: 'POST', body: { code: '111111' } }),
    );
    expect(replay.status).toBe(400);
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });

  it('refuses a code spent at sign-in when it is replayed as a step-up proof', async () => {
    const uid = freshUser();
    expect((await signInCode(uid, '111111', '198.51.100.1')).status).toBe(200);
    expect(await verifyMfaProof(uid, { kind: 'totp', code: '111111' }, users.get(uid)!)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await verifyMfaProof(uid, { kind: 'totp', code: '222222' }, users.get(uid)!)).toEqual({
      ok: true,
      factorUsed: 'totp',
    });
  });
});
