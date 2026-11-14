/** @jest-environment node */

/**
 * `POST /api/mfa/backup-codes`. Pins: ten plaintext codes returned but only
 * hashes stored; all three proofs (TOTP, backup code, UV-verified passkey)
 * genuinely verified; a proof-less request refused BEFORE any write — a warm
 * session alone must not mint codes that satisfy `/api/mfa/disable`;
 * regeneration replaces the prior generation; plaintext never persisted.
 *
 * `@/lib/backupCodes.server` and `hashBackupCode` are deliberately NOT mocked —
 * the "never persisted" assertion is meaningless against a fake hash.
 */

const mockRequireSession = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockDecrypt = jest.fn();
const mockIsEncryptionConfigured = jest.fn();
const mockEmitMutation = jest.fn();
const mockGetAndDeleteChallenge = jest.fn();
const mockGetUserPasskeys = jest.fn();
const mockUpdatePasskeyCounter = jest.fn();
const mockVerifyAuthenticationResponse = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/apiAuth.server', () => {
  // inline: jest hoists the factory above module scope, so top-level classes aren't ready
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
    requireSession: (...a: unknown[]) => mockRequireSession(...a),
  };
});

// Real `hashBackupCode`; only the verifiers are stubbed, so a test can assert a
// match without minting a real TOTP secret.
jest.mock('@/lib/totp', () => {
  const actual = jest.requireActual('@/lib/totp');
  return {
    hashBackupCode: actual.hashBackupCode,
    verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
    verifyBackupCode: (...a: unknown[]) => mockVerifyBackupCode(...a),
  };
});

// the attempt budget and the spent-step record are covered in code-attempts.test.ts
jest.mock('@/lib/mfaAttempts.server', () => ({
  spendMfaAttempt: async () => ({ success: true }),
  consumeTotpCode: async (_uid: string, code: string, secret: string) => mockVerifyTOTP(code, secret),
}));

jest.mock('@/lib/encryption.server', () => ({
  decrypt: (...a: unknown[]) => mockDecrypt(...a),
  isEncryptionConfigured: (...a: unknown[]) => mockIsEncryptionConfigured(...a),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'localhost',
  getExpectedOrigins: () => ['http://localhost:3000'],
  getAndDeleteChallenge: (...a: unknown[]) => mockGetAndDeleteChallenge(...a),
  getUserPasskeys: (...a: unknown[]) => mockGetUserPasskeys(...a),
  updatePasskeyCounter: (...a: unknown[]) => mockUpdatePasskeyCounter(...a),
}));

jest.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: (...a: unknown[]) => mockVerifyAuthenticationResponse(...a),
}));

jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { toBuffer: (v: string) => Buffer.from(v, 'base64') },
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__SERVER_TIMESTAMP__' },
}));

/** Mutable user doc backing the mocked admin SDK. */
let userData: Record<string, unknown> | null;
/** Every payload written to `users/user-1`, in order. */
const writes: Array<Record<string, unknown>> = [];

function recordWrite(payload: Record<string, unknown>) {
  writes.push(payload);
  if (userData) userData = { ...userData, ...payload };
}

function makeUserRef() {
  return {
    id: 'user-1',
    get: async () => ({
      exists: userData !== null,
      data: () => userData ?? undefined,
    }),
    update: async (payload: Record<string, unknown>) => recordWrite(payload),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({ doc: () => makeUserRef() }),
    runTransaction: (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async () => ({
          exists: userData !== null,
          data: () => userData ?? undefined,
        }),
        update: (_ref: unknown, payload: Record<string, unknown>) => recordWrite(payload),
        set: (_ref: unknown, payload: Record<string, unknown>) => recordWrite(payload),
      };
      return cb(tx);
    },
  }),
}));

import { POST } from '@/app/api/mfa/backup-codes/route';
import { hashBackupCode } from '@/lib/totp';
import { createMockRequest } from '../helpers/utils';

const USER_ID = 'user-1';
/** The generation already on the account before each test's regeneration. */
const OLD_HASHES = ['old-hash-1', 'old-hash-2', 'old-hash-3'];

beforeEach(() => {
  jest.clearAllMocks();
  userData = {
    mfaEnrolled: true,
    mfaSecret: 'salt:iv:tag:cipher',
    backupCodes: [...OLD_HASHES],
  };
  writes.length = 0;

  mockRequireSession.mockResolvedValue(USER_ID);
  mockAssertActiveUser.mockImplementation(async () => userData);
  mockIsEncryptionConfigured.mockReturnValue(true);
  mockDecrypt.mockReturnValue('TOTP_SECRET');
  mockVerifyTOTP.mockReturnValue(true);
  mockVerifyBackupCode.mockReturnValue(false);
});

function codesReq(body: unknown) {
  return createMockRequest('http://localhost/api/mfa/backup-codes', {
    method: 'POST',
    body: body as Record<string, unknown>,
  });
}

/** The `backupCodes` array this request wrote, if it wrote one. */
function writtenCodes(): string[] | undefined {
  const write = [...writes].reverse().find((w) => Array.isArray(w.backupCodes));
  return write?.backupCodes as string[] | undefined;
}

/** A passkey proof body plus the mocks that make it verify. */
function armPasskey({ verified = true }: { verified?: boolean } = {}) {
  mockGetAndDeleteChallenge.mockResolvedValue({
    challenge: 'CHALLENGE',
    userId: USER_ID,
    type: 'authentication',
    expiresAt: new Date(Date.now() + 60_000),
  });
  mockGetUserPasskeys.mockResolvedValue([
    {
      credentialId: 'cred-1',
      credentialPublicKey: 'AAAA',
      counter: 4,
      transports: ['internal'],
    },
  ]);
  mockVerifyAuthenticationResponse.mockResolvedValue({
    verified,
    authenticationInfo: { newCounter: 5 },
  });
  return { credential: { id: 'cred-1' }, challengeId: 'challenge-1' };
}

describe('POST /api/mfa/backup-codes — happy path', () => {
  it('returns ten plaintext codes and stores only their hashes', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(10);
    expect(body.backupCodes).toHaveLength(10);
    expect(new Set(body.backupCodes).size).toBe(10);

    const stored = writtenCodes();
    expect(stored).toHaveLength(10);
    // position-for-position: the sheet the user sees is the sheet that verifies
    expect(stored).toEqual((body.backupCodes as string[]).map(hashBackupCode));
  });

  it('stamps backupCodesGeneratedAt and touches no factor-inventory field', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const write = writes.find((w) => Array.isArray(w.backupCodes))!;
    expect(write.backupCodesGeneratedAt).toBe('__SERVER_TIMESTAMP__');
    // only lib/mfaFactors.server.ts writes these; codes are not a factor
    expect(write).not.toHaveProperty('mfaEnrolled');
    expect(write).not.toHaveProperty('requiresMfaSetup');
    expect(write).not.toHaveProperty('mfaFactors');
  });

  it('emits a user_mutated audit row naming the proof that was presented', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(200);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.siteId).toBe('');
    expect(audit.actor).toBe(`user:${USER_ID}`);
    expect(audit.attributes).toMatchObject({
      endpoint: '/api/mfa/backup-codes',
      verb: 'mfa_backup_codes_regenerated',
      factorUsed: 'totp',
      backupCodesIssued: 10,
    });
  });
});

describe('POST /api/mfa/backup-codes — proof of possession', () => {
  it('accepts a current TOTP code', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(200);
    expect(mockVerifyTOTP).toHaveBeenCalledWith('123456', 'TOTP_SECRET');
  });

  it('rejects a wrong TOTP code and writes nothing', async () => {
    mockVerifyTOTP.mockReturnValue(false);

    const res = await POST(codesReq({ code: '999999' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_mfa_proof');
    expect(writtenCodes()).toBeUndefined();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('accepts an existing backup code and consumes it', async () => {
    mockVerifyBackupCode.mockImplementation(
      (code: string, hash: string) => code === 'A1B2C3D4' && hash === 'old-hash-2',
    );

    const res = await POST(codesReq({ code: 'A1B2C3D4', isBackupCode: true }));
    expect(res.status).toBe(200);

    // consumption inside the verification txn, then the replacement sheet
    expect(writes[0].backupCodes).toEqual(['old-hash-1', 'old-hash-3']);
    expect(writtenCodes()).toHaveLength(10);
    expect(mockEmitMutation.mock.calls[0][0].attributes.factorUsed).toBe('backup_code');
  });

  it('rejects a backup code that matches nothing', async () => {
    mockVerifyBackupCode.mockReturnValue(false);

    const res = await POST(codesReq({ code: 'DEADBEEF', isBackupCode: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_mfa_proof');
    expect(writes).toHaveLength(0);
  });

  it('accepts a UV-verified passkey step-up assertion', async () => {
    const proof = armPasskey();

    const res = await POST(codesReq(proof));
    expect(res.status).toBe(200);
    expect(writtenCodes()).toHaveLength(10);
    expect(mockEmitMutation.mock.calls[0][0].attributes.factorUsed).toBe('passkey');

    // UV required: without it a passkey proves possession only, and the output here
    // is a permanent offline factor.
    const args = mockVerifyAuthenticationResponse.mock.calls[0][0];
    expect(args.requireUserVerification).toBe(true);
    expect(args.expectedChallenge).toBe('CHALLENGE');
    expect(mockUpdatePasskeyCounter).toHaveBeenCalledWith(USER_ID, 'cred-1', 5);
  });

  it('rejects a passkey assertion that fails verification', async () => {
    const proof = armPasskey({ verified: false });

    const res = await POST(codesReq(proof));
    expect(res.status).toBe(400);
    expect(writtenCodes()).toBeUndefined();
  });

  it("rejects a challenge minted for somebody else's account", async () => {
    const proof = armPasskey();
    mockGetAndDeleteChallenge.mockResolvedValue({
      challenge: 'CHALLENGE',
      userId: 'someone-else',
      type: 'authentication',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await POST(codesReq(proof));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('challenge_user_mismatch');
    expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(writtenCodes()).toBeUndefined();
  });

  it('refuses a request carrying no proof at all', async () => {
    // The attack: a stolen `__session` cookie minting a permanent offline factor
    // that also unlocks /api/mfa/disable.
    const res = await POST(codesReq({}));
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.code).toBe('mfa_proof_required');
    expect(body.error).toMatch(/required/i);

    expect(writes).toHaveLength(0);
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockVerifyTOTP).not.toHaveBeenCalled();
  });

  it('refuses a passkey proof that omits the challenge it was issued against', async () => {
    armPasskey();

    const res = await POST(codesReq({ credential: { id: 'cred-1' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_passkey_proof');
    expect(mockGetAndDeleteChallenge).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('refuses a session-only caller even when the session claims MFA is verified', async () => {
    // `mfaVerified` is never consulted; no body shape substitutes for a live factor
    const res = await POST(codesReq({ mfaVerified: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('mfa_proof_required');
    expect(writes).toHaveLength(0);
  });

  it('returns 401 when there is no session', async () => {
    const { ApiAuthError } = jest.requireMock('@/lib/apiAuth.server') as {
      ApiAuthError: new (status: number, message: string) => Error;
    };
    mockRequireSession.mockRejectedValueOnce(new ApiAuthError(401, 'Unauthorized'));

    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
  });
});

describe('POST /api/mfa/backup-codes — regeneration semantics', () => {
  it('replaces the previous generation wholesale', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    expect(res.status).toBe(200);

    const stored = writtenCodes()!;
    // not a merge: last month's written-down code no longer opens the account
    for (const old of OLD_HASHES) {
      expect(stored).not.toContain(old);
    }
    expect(userData!.backupCodes).toEqual(stored);
  });

  it('never persists plaintext', async () => {
    const res = await POST(codesReq({ code: '123456' }));
    const body = await res.json();

    const persisted = JSON.stringify(writes).toLowerCase();
    for (const code of body.backupCodes as string[]) {
      expect(persisted).not.toContain(code.toLowerCase());
    }
  });
});
