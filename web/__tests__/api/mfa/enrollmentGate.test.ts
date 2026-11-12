/** @jest-environment node */

/**
 * The factor-enrollment gate on `/api/mfa/setup` and `/api/mfa/verify-setup`.
 *
 * `/api/*` is not MFA-gated, so without this gate a stolen `__session` cookie
 * could enroll its own factor and step up with it.
 *
 * The rule pinned here:
 *   - zero factors -> enrollment OPEN. A user who never enrolled can never hold
 *     `mfaVerified`, so gating would deadlock them out of enrolling at all.
 *   - any factor   -> a session that cleared a challenge, else 403
 *     `mfa_challenge_required`. `mfaVerified` alone is not that: a sign-in from
 *     before the account held a factor also carries it.
 *
 * Plus the per-factor rule that replaced verify-setup's blanket 409: a
 * passkey-only account may ADD TOTP, but a live TOTP secret is never
 * overwritten in place — disable, then enroll.
 */

const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockGetSessionData = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockReadMfaFactors = jest.fn();
const mockApplyMfaFactorChange = jest.fn();
const mockEmitMutation = jest.fn();
const mockGenerateTOTPSecret = jest.fn();
const mockGenerateQRCode = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockHashBackupCode = jest.fn();
const mockPendingSet = jest.fn();
const mockPendingDelete = jest.fn();

const mockSendEmail = jest.fn();
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () => ({ emails: { send: (...a: unknown[]) => mockSendEmail(...a) } }),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  // Inline: jest hoists the factory above module scope, so a top-level class
  // isn't initialised yet.
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
    requirePreMfaSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionData: (...a: unknown[]) => mockGetSessionData(...a),
  markSessionMfaVerified: (...a: unknown[]) => mockMarkSessionMfaVerified(...a),
}));

// Stubbed on purpose: these tests are about the GATE, not the denormalization
// (mfaFactors.test.ts covers that). `deriveMfaEnrolled` keeps its real
// semantics so the gate isn't tested against a fiction.
jest.mock('@/lib/mfaFactors.server', () => ({
  deriveMfaEnrolled: (inv: { totp: boolean; passkeys: number }) =>
    inv.totp || inv.passkeys > 0,
  readMfaFactors: (...a: unknown[]) => mockReadMfaFactors(...a),
  applyMfaFactorChange: (...a: unknown[]) => mockApplyMfaFactorChange(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

jest.mock('@/lib/totp', () => ({
  generateTOTPSecret: (...a: unknown[]) => mockGenerateTOTPSecret(...a),
  generateQRCode: (...a: unknown[]) => mockGenerateQRCode(...a),
  verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
  hashBackupCode: (...a: unknown[]) => mockHashBackupCode(...a),
}));

jest.mock('@/lib/encryption.server', () => ({
  encrypt: (v: string) => `enc(${v})`,
  isEncryptionConfigured: () => true,
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TIMESTAMP__' },
  Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
}));

/** The `mfa_pending/{uid}` document the setup step parks the secret in. */
let pendingDoc: Record<string, unknown> | null;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: pendingDoc !== null,
          data: () => pendingDoc ?? undefined,
        }),
        set: (...a: unknown[]) => mockPendingSet(...a),
        delete: (...a: unknown[]) => mockPendingDelete(...a),
      }),
    }),
  }),
}));

import { POST as SETUP } from '@/app/api/mfa/setup/route';
import { POST as VERIFY_SETUP } from '@/app/api/mfa/verify-setup/route';
import { createMockRequest } from '../helpers/utils';

const USER_ID = 'user-1';
const VERIFIED_SESSION = { userId: USER_ID, mfaRequired: true, mfaVerified: true, mfaCompletedAt: 1 };

beforeEach(() => {
  jest.clearAllMocks();

  // Brand-new account, session that has NOT cleared a challenge.
  mockRequireSessionUser.mockResolvedValue(USER_ID);
  mockAssertActiveUser.mockResolvedValue({ email: 'owner@example.test' });
  mockSendEmail.mockResolvedValue({ error: null });
  mockGetSessionData.mockResolvedValue({ userId: USER_ID });
  mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 0 });
  mockApplyMfaFactorChange.mockResolvedValue({
    factors: { totp: true, passkeys: 0 },
    mfaEnrolled: true,
    requiresMfaSetup: false,
  });
  mockGenerateTOTPSecret.mockReturnValue('SECRET');
  mockGenerateQRCode.mockResolvedValue('data:image/png;base64,QR');
  mockVerifyTOTP.mockReturnValue(true);
  mockHashBackupCode.mockImplementation((c: string) => `hash(${c})`);
  mockPendingSet.mockResolvedValue(undefined);
  mockPendingDelete.mockResolvedValue(undefined);

  pendingDoc = {
    secret: 'SECRET',
    email: 'user@example.com',
    expiresAt: { toDate: () => new Date(Date.now() + 5 * 60 * 1000) },
  };
});

function setupReq() {
  return createMockRequest('http://localhost/api/mfa/setup', {
    method: 'POST',
    body: { userId: USER_ID, email: 'user@example.com' },
  });
}

function verifySetupReq() {
  return createMockRequest('http://localhost/api/mfa/verify-setup', {
    method: 'POST',
    body: { userId: USER_ID, code: '123456', backupCodes: ['AAAA-BBBB'] },
  });
}

describe('POST /api/mfa/setup — enrollment gate', () => {
  it('is open for an account with no factor, even on an unverified session', async () => {
    // The real "starting setup" state; beforeEach's seeded secret would send
    // this down the idempotent-reuse path instead of the mint.
    pendingDoc = null;

    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });

  // Idempotent by design: setup-2fa calls it from an effect, so a remount
  // POSTs again. Minting per call let the last write win while the user read a
  // QR from an earlier response — verify-setup then rejected a correct code.
  // That race failed the setup-2fa e2e spec ~50% of runs.
  it('reuses an unexpired pending secret instead of minting a new one', async () => {
    const res = await SETUP(setupReq());

    expect(res.status).toBe(200);
    expect((await res.json()).secret).toBe('SECRET');
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('mints a fresh secret when the pending one has expired', async () => {
    pendingDoc = {
      secret: 'STALE',
      email: 'user@example.com',
      expiresAt: { toDate: () => new Date(Date.now() - 60 * 1000) },
    };

    const res = await SETUP(setupReq());

    expect(res.status).toBe(200);
    expect((await res.json()).secret).not.toBe('STALE');
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });

  it('returns 403 mfa_challenge_required when a factor already exists', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });

    const res = await SETUP(setupReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('mfa_challenge_required');
    // The flow stops before any side effect.
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('refuses a sign-in from before the account held a factor', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    mockGetSessionData.mockResolvedValue({ userId: USER_ID, mfaRequired: false, mfaVerified: true });

    const res = await SETUP(setupReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockPendingSet).not.toHaveBeenCalled();
  });

  it('lets an MFA-verified session add a second factor', async () => {
    pendingDoc = null;
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);
    expect(mockPendingSet).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/mfa/verify-setup — enrollment gate', () => {
  it('completes first-time enrollment on an unverified session', async () => {
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);
    expect(mockApplyMfaFactorChange).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);
  });

  it("tells the account's own address, not the one in the setup body", async () => {
    pendingDoc = { ...pendingDoc, email: 'someone-else@example.test' };

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.test',
      subject: 'authenticator app added to your owlette account',
    });
  });

  it('returns the backup codes when the send fails', async () => {
    mockSendEmail.mockRejectedValue(new Error('resend down'));

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);
    expect((await res.json()).backupCodes).toEqual(['AAAA-BBBB']);
  });

  it('returns 403 for a passkey-only account on an unverified session', async () => {
    // THE BYPASS THIS CLOSES: narrowing the blanket 409 to a per-factor check
    // would otherwise let a stolen session bolt its own TOTP onto a
    // passkey-only account and step up with it.
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('mfa_challenge_required');
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('lets a verified passkey-only account add TOTP', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    // The route passes the factor delta plus its payload — never the two
    // derived flags.
    const [userId, change, ctx] = mockApplyMfaFactorChange.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(change).toEqual({ totp: true });
    expect(ctx.extraUpdate).toMatchObject({
      mfaSecret: 'enc(SECRET)',
      backupCodes: ['hash(AAAA-BBBB)'],
      mfaEnrolledAt: '__SERVER_TIMESTAMP__',
    });
    expect(ctx.extraUpdate).not.toHaveProperty('mfaEnrolled');
    expect(ctx.extraUpdate).not.toHaveProperty('requiresMfaSetup');
  });

  it('still refuses to overwrite a live TOTP secret, verified or not', async () => {
    mockReadMfaFactors.mockResolvedValue({ totp: true, passkeys: 0 });
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('mfa_already_enrolled');
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });
});

describe('POST /api/mfa/verify-setup — backup codes', () => {
  // The one issuance needing no separate proof of possession: the TOTP code
  // just verified IS the proof, and the gate already refused any account
  // holding a factor. Every later issuance goes through /api/mfa/backup-codes.
  it('mints the sheet server-side when the client sends none', async () => {
    const req = createMockRequest('http://localhost/api/mfa/verify-setup', {
      method: 'POST',
      body: { userId: USER_ID, code: '123456' },
    });

    const res = await VERIFY_SETUP(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.backupCodes).toHaveLength(10);
    expect(new Set(body.backupCodes).size).toBe(10);

    // Only hashes are stored, and they match the returned sheet.
    const [, , ctx] = mockApplyMfaFactorChange.mock.calls[0];
    expect(ctx.extraUpdate.backupCodes).toEqual(
      (body.backupCodes as string[]).map((c) => `hash(${c})`),
    );
  });

  it('stamps backupCodesGeneratedAt alongside the sheet', async () => {
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    const [, , ctx] = mockApplyMfaFactorChange.mock.calls[0];
    expect(ctx.extraUpdate.backupCodesGeneratedAt).toBe('__SERVER_TIMESTAMP__');
  });

  it('still honours a client-supplied sheet and echoes it back', async () => {
    // Transitional: setup-2fa generates in the browser and is already showing
    // those codes — storing a different set hands the user ten dead strings.
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);
    expect((await res.json()).backupCodes).toEqual(['AAAA-BBBB']);
  });

  it('rejects a malformed sheet', async () => {
    const req = createMockRequest('http://localhost/api/mfa/verify-setup', {
      method: 'POST',
      body: { userId: USER_ID, code: '123456', backupCodes: [123] },
    });

    const res = await VERIFY_SETUP(req);
    expect(res.status).toBe(400);
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });
});

describe('POST /api/mfa/setup — audit', () => {
  it('emits a user_mutated row when a pending secret is minted', async () => {
    pendingDoc = null;

    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe(`user:${USER_ID}`);
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.attributes).toMatchObject({
      endpoint: '/api/mfa/setup',
      method: 'POST',
      verb: 'mfa_enrollment_started',
      factor: 'totp',
      passkeysEnrolled: 0,
    });
    // The TOTP secret is the whole factor — it must never be recorded.
    expect(JSON.stringify(audit)).not.toContain('SECRET');
  });

  it('emits nothing on the idempotent reuse path — no state changed', async () => {
    const res = await SETUP(setupReq());
    expect(res.status).toBe(200);
    expect(mockPendingSet).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('emits nothing when the enrollment gate denies', async () => {
    pendingDoc = null;
    mockReadMfaFactors.mockResolvedValue({ totp: false, passkeys: 1 });

    const res = await SETUP(setupReq());
    expect(res.status).toBe(403);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('POST /api/mfa/verify-setup — audit', () => {
  it('emits a user_mutated row recording the added factor', async () => {
    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(200);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe(`user:${USER_ID}`);
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.attributes).toMatchObject({
      endpoint: '/api/mfa/verify-setup',
      method: 'POST',
      verb: 'mfa_enrolled',
      factor: 'totp',
      backupCodesIssued: 1,
    });
  });

  it('emits nothing when the TOTP code is wrong', async () => {
    mockVerifyTOTP.mockReturnValue(false);

    const res = await VERIFY_SETUP(verifySetupReq());
    expect(res.status).toBe(400);
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockApplyMfaFactorChange).not.toHaveBeenCalled();
  });
});
