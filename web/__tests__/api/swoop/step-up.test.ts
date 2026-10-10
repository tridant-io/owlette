/** @jest-environment node */

/**
 * the step-up on its own, for owlette swoop's "verify in your browser":
 *
 *   POST /api/sites/{siteId}/machines/{machineId}/swoop/step-up — a proof opens the window
 *   GET  /api/sites/{siteId}/machines/{machineId}/swoop/step-up — is it open for this sign-in?
 *
 * the real `authorizedSiteHandler` and site-access gate run; the ceremony's
 * verification and the cookie plumbing are what is replaced, as in
 * sessions.test.ts.
 */

import { createMockRequest, parseResponse } from '../helpers/utils';
import {
  mocks,
  mockDbFactory,
  docSnapshot,
  seedMember,
  seedSiteOwner,
  apiKeyAuth,
  SITE_OWNER,
} from '../helpers/firestore-mock';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => mockDbFactory(),
  getAdminAuth: () => ({ verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')) }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: jest.fn(() => '__SERVER_TS__') },
  Timestamp: { fromMillis: (ms: number) => ({ toMillis: () => ms }) },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: jest.fn(),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const writeAuditEntry = jest.fn();
const writeAuditEntryBlocking = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('@/lib/auditLog.server', () => ({
  generateCorrelationId: jest.fn(() => 'corr-test'),
  writeAuditEntry: (...a: unknown[]) => writeAuditEntry(...a),
  writeAuditEntryBlocking: (...a: unknown[]) => writeAuditEntryBlocking(...a),
}));

const mockCheckRateLimit = jest.fn(async (..._args: unknown[]) => ({ ok: true }));
jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
  rateLimitHeaders: jest.fn(() => ({})),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({ capability_enforcement: true, rate_limit_enforcement: true })),
  },
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, resolveAuth: (...a: unknown[]) => mockResolveAuth(...a) };
});

/** the login session behind the request; the satisfier predicate is the real one. */
const mockLogin: { userId: string; expiresAt: number; mfaSatisfiedBy?: string; mfaCompletedAt?: number } = {
  userId: '',
  expiresAt: 0,
};
const mockMarkCeremony = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: jest.fn(async () => mockLogin),
  sessionPassedMfaCeremony: jest.requireActual('@/lib/sessionManager.server')
    .sessionPassedMfaCeremony,
  markSessionMfaCeremony: (...a: unknown[]) => mockMarkCeremony(...a),
}));

const mfaFactors = { totp: true, passkeys: 0 };
jest.mock('@/lib/mfaFactors.server', () => ({
  readMfaFactors: jest.fn(async () => mfaFactors),
  deriveMfaEnrolled: (f: { totp: boolean; passkeys: number }) => f.totp || f.passkeys > 0,
}));

const mockVerifyMfaProof = jest.fn();
jest.mock('@/lib/mfaProof.server', () => {
  const actual = jest.requireActual('@/lib/mfaProof.server');
  return { ...actual, verifyMfaProof: (...a: unknown[]) => mockVerifyMfaProof(...a) };
});

const mockOpenStepUpWindow = jest.fn();
jest.mock('@/lib/swoop/policy.server', () => {
  const actual = jest.requireActual('@/lib/swoop/policy.server');
  return {
    ...actual,
    openStepUpWindow: (...a: unknown[]) => {
      mockOpenStepUpWindow(...a);
      return actual.openStepUpWindow(...a);
    },
  };
});

import { ApiAuthError } from '@/lib/apiAuth.server';
import { GET, POST } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/step-up/route';
import { stepUpMachineBinding } from '@/lib/swoop/policy.server';

const SITE = 'site-a';
const MACHINE = 'machine-1';
const ADMIN = 'user-admin';
const MEMBER = 'user-member';

const staged = new Map<string, Record<string, unknown> | null>();

const url = (machineId = MACHINE) =>
  `http://localhost/api/sites/${SITE}/machines/${machineId}/swoop/step-up`;

const routeContext = (machineId = MACHINE) => ({
  params: Promise.resolve({ siteId: SITE, machineId }),
});

const post = (body: Record<string, unknown>) =>
  POST(createMockRequest(url(), { method: 'POST', body }), routeContext());

const get = (machineId = MACHINE) => GET(createMockRequest(url(machineId)), routeContext(machineId));

/** a ceremony sign-in an hour ago unless the test says otherwise: too old to stand in for the step-up. */
function signIn(
  userId: string,
  satisfiedBy: 'challenge' | 'device-trust' = 'challenge',
  signedInAgoMs = 3_600_000,
): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
  mockLogin.userId = userId;
  mockLogin.expiresAt = Date.now() + 86_400_000;
  mockLogin.mfaSatisfiedBy = satisfiedBy;
  mockLogin.mfaCompletedAt = Date.now() - signedInAgoMs;
}

/** a ceremony this user already ran, for one machine. */
function openWindow(userId: string, machineId = MACHINE): void {
  const binding = stepUpMachineBinding({ userId, siteId: SITE, machineId });
  const openedAt = Date.now();
  staged.set(`users/${userId}/swoop_step_up/${binding}`, {
    openedAt,
    expiresAt: openedAt + 600_000,
    factorUsed: 'totp',
  });
}

/** swoop's own audit rows, told apart from the wrapper's by `metadata.event`. */
const swoopDenials = () =>
  (writeAuditEntry.mock.calls as [string, { denyReason?: string; metadata?: Record<string, unknown> }][])
    .filter(([site, entry]) => site === SITE && typeof entry.metadata?.event === 'string')
    .map(([, entry]) => ({ event: entry.metadata?.event, denyReason: entry.denyReason }));

beforeEach(() => {
  jest.clearAllMocks();
  mfaFactors.totp = true;
  mfaFactors.passkeys = 0;
  mockVerifyMfaProof.mockResolvedValue({ ok: true, factorUsed: 'totp' });

  staged.clear();
  staged.set(`sites/${SITE}/settings/swoop`, { enabled: true });
  mocks.get.mockImplementation((path: string) =>
    Promise.resolve(docSnapshot(path.split('/').pop() ?? '', staged.get(path) ?? null)),
  );

  seedSiteOwner(SITE);
  seedMember(SITE, ADMIN, 'admin');
  seedMember(SITE, MEMBER, 'member');
  signIn(ADMIN);
});

describe('POST swoop/step-up', () => {
  it('refuses an unauthenticated caller with 401', async () => {
    mockResolveAuth.mockRejectedValue(new ApiAuthError(401, 'no session'));

    const res = await post({ mfaProof: { code: '123456' } });

    expect(res.status).toBe(401);
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
  });

  it('refuses an api key with 403 api_key_not_permitted and records it', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));

    const { status, body } = await parseResponse(await post({ mfaProof: { code: '123456' } }));

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
    expect(swoopDenials()).toEqual([{ event: 'step_up_failed', denyReason: 'api_key_not_permitted' }]);
  });

  it('answers a missing proof with the proof error and opens nothing', async () => {
    const { status, body } = await parseResponse(await post({}));

    expect(status).toBe(400);
    expect(body.code).toBe('mfa_proof_required');
    expect(mockOpenStepUpWindow).not.toHaveBeenCalled();
  });

  it('answers a rejected proof with the proof error, records it and opens nothing', async () => {
    mockVerifyMfaProof.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'invalid verification code',
      code: 'invalid_mfa_proof',
    });

    const { status, body } = await parseResponse(await post({ mfaProof: { code: '123456' } }));

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid verification code', code: 'invalid_mfa_proof' });
    expect(mockOpenStepUpWindow).not.toHaveBeenCalled();
    expect(mockMarkCeremony).not.toHaveBeenCalled();
    expect(swoopDenials()).toEqual([{ event: 'step_up_failed', denyReason: 'proof_rejected' }]);
  });

  it('refuses a zero-factor account before verifying its proof', async () => {
    mfaFactors.totp = false;

    const { status, body } = await parseResponse(await post({ mfaProof: { code: '123456' } }));

    expect(status).toBe(401);
    expect(body.code).toBe('step_up_required');
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
  });

  it('opens the window for this user on this machine from a live proof, and answers 204', async () => {
    const res = await post({ mfaProof: { code: '123456' } });

    expect(res.status).toBe(204);
    expect(mockVerifyMfaProof).toHaveBeenCalledWith(
      ADMIN,
      { kind: 'totp', code: '123456' },
      expect.anything(),
    );
    expect(mockOpenStepUpWindow).toHaveBeenCalledTimes(1);
    const [opened] = mockOpenStepUpWindow.mock.calls[0] as [Record<string, unknown>];
    expect(opened).toMatchObject({ userId: ADMIN, siteId: SITE, machineId: MACHINE, proof: { ok: true, factorUsed: 'totp' } });
    expect(stepUpMachineBinding(opened as { userId: string; siteId: string; machineId: string })).toBe(
      stepUpMachineBinding({ userId: ADMIN, siteId: SITE, machineId: MACHINE }),
    );
    expect(mockMarkCeremony).toHaveBeenCalledWith(ADMIN);
    // the wrapper's allow row on the control capability, rate-limited like a control session
    expect(writeAuditEntryBlocking).toHaveBeenCalledWith(
      SITE,
      expect.objectContaining({ outcome: 'allow', capability: 'MACHINE_REMOTE_CONTROL' }),
    );
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), 'MACHINE_REMOTE_CONTROL', SITE);
  });

  it('spends no proof on a site with swoop off', async () => {
    staged.set(`sites/${SITE}/settings/swoop`, { enabled: false });

    const { status, body } = await parseResponse(await post({ mfaProof: { code: '123456' } }));

    expect(status).toBe(403);
    expect(body.code).toBe('swoop_disabled');
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
    expect(swoopDenials()).toEqual([{ event: 'step_up_failed', denyReason: 'swoop_disabled' }]);
  });

  it('refuses a member without the control capability', async () => {
    signIn(MEMBER);

    const res = await post({ mfaProof: { code: '123456' } });

    expect(res.status).toBe(403);
    expect(mockVerifyMfaProof).not.toHaveBeenCalled();
  });
});

describe('GET swoop/step-up', () => {
  it('refuses an unauthenticated caller with 401', async () => {
    mockResolveAuth.mockRejectedValue(new ApiAuthError(401, 'no session'));

    expect((await get()).status).toBe(401);
  });

  it('refuses an api key with 403 api_key_not_permitted', async () => {
    mockResolveAuth.mockResolvedValue(apiKeyAuth(SITE_OWNER));

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(403);
    expect(body.code).toBe('api_key_not_permitted');
  });

  it('refuses a stranger to the site with 404', async () => {
    signIn('user-stranger');
    mocks.userDocs.set('user-stranger', { email: 'x@example.test', role: 'member', sites: [] });

    expect((await get()).status).toBe(404);
  });

  it('reads open for a ceremony-backed sign-in with a window on this machine', async () => {
    openWindow(ADMIN);

    const { status, body } = await parseResponse(await get());

    expect(status).toBe(200);
    expect(body.data).toEqual({ open: true, sessionPassedCeremony: true });
  });

  it('reads closed with no window', async () => {
    const { body } = await parseResponse(await get());

    expect(body.data).toEqual({ open: false, sessionPassedCeremony: true });
  });

  it('reads closed for a window on another machine', async () => {
    openWindow(ADMIN, 'machine-2');

    const { body } = await parseResponse(await get());

    expect(body.data).toEqual({ open: false, sessionPassedCeremony: true });
  });

  it('tells a device-trust sign-in it can never read the window, even an open one', async () => {
    signIn(ADMIN, 'device-trust');
    openWindow(ADMIN);

    const { body } = await parseResponse(await get());

    expect(body.data).toEqual({ open: false, sessionPassedCeremony: false });
  });

  // the app's poll after a fresh sign-in: the create that follows opens the window
  it('reads open for a second factor this sign-in passed minutes ago, and writes nothing', async () => {
    signIn(ADMIN, 'challenge', 2 * 60_000);

    const { body } = await parseResponse(await get());

    expect(body.data).toEqual({ open: true, sessionPassedCeremony: true });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(writeAuditEntryBlocking).not.toHaveBeenCalled();
  });

  it('reads closed for a device-trust sign-in however recent, and a ceremony six minutes old', async () => {
    signIn(ADMIN, 'device-trust', 0);
    expect((await parseResponse(await get())).body.data).toEqual({ open: false, sessionPassedCeremony: false });

    signIn(ADMIN, 'challenge', 6 * 60_000);
    expect((await parseResponse(await get())).body.data).toEqual({ open: false, sessionPassedCeremony: true });
  });

  it('writes no audit row and takes no rate-limit token per poll', async () => {
    openWindow(ADMIN);

    await get();

    expect(writeAuditEntryBlocking).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
