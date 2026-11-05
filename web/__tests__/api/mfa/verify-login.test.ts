/** @jest-environment node */

/**
 * Concurrency tests for `/api/mfa/verify-login`'s backup-code path.
 *
 * Guards a race where two parallel logins with the same backup code both
 * succeeded; consumption now goes through `db.runTransaction`. The CAS mock
 * below simulates contention: both txns read the same list, only the first
 * commit wins, and the loser re-runs against post-commit state → `no_match`.
 */

const mockVerifyTOTP = jest.fn();
const mockVerifyBackupCode = jest.fn();
const mockDecrypt = jest.fn();
const mockIsEncryptionConfigured = jest.fn().mockReturnValue(true);
const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockMintDeviceTrustToken = jest.fn();
const mockCreateTrustedDevice = jest.fn();

/** Keep in sync with the real DEVICE_TRUST_COOKIE constant. */
const TRUST_COOKIE = 'owlette_device_trust';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/withRateLimit', () => ({
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
    requireSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/totp', () => ({
  verifyTOTP: (...a: unknown[]) => mockVerifyTOTP(...a),
  verifyBackupCode: (...a: unknown[]) => mockVerifyBackupCode(...a),
}));

jest.mock('@/lib/encryption.server', () => ({
  decrypt: (...a: unknown[]) => mockDecrypt(...a),
  isEncryptionConfigured: () => mockIsEncryptionConfigured(),
}));

jest.mock('@/lib/sessionManager.server', () => ({
  markSessionMfaVerified: (...a: unknown[]) =>
    mockMarkSessionMfaVerified(...a),
}));

jest.mock('@/lib/deviceTrust.server', () => ({
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  mintDeviceTrustToken: () => mockMintDeviceTrustToken(),
  createTrustedDevice: (...a: unknown[]) => mockCreateTrustedDevice(...a),
  deviceTrustCookieOptions: () => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  }),
}));

/**
 * Shared mutable doc state. The runTransaction simulator applies optimistic
 * concurrency control by tracking the doc version at read time and rejecting
 * stale-pre-image writes, then re-invoking the callback — mirroring Firestore's
 * auto-retry, so the losing call re-reads and returns `no_match`.
 */
interface DocState {
  version: number;
  exists: boolean;
  data: Record<string, unknown>;
}

let docState: DocState;
let txOpsLog: Array<{ action: 'read' | 'update'; version: number }>;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: docState.exists,
          data: () => docState.data,
        }),
      }),
    }),
    runTransaction: async <T>(
      cb: (tx: unknown) => Promise<T>,
    ): Promise<T> => {
      // Firestore's optimistic-CAS retry: rerun once if the read version was
      // stale at commit. Two passes is enough for a parallel collision.
      for (let attempt = 0; attempt < 2; attempt++) {
        const readVersion = docState.version;
        const snapshot = {
          exists: docState.exists,
          data: () => ({ ...docState.data }),
        };
        const pendingUpdates: Record<string, unknown>[] = [];
        const tx = {
          get: async () => {
            txOpsLog.push({ action: 'read', version: readVersion });
            return snapshot;
          },
          update: (_ref: unknown, payload: Record<string, unknown>) => {
            pendingUpdates.push(payload);
            txOpsLog.push({ action: 'update', version: readVersion });
          },
        };
        const result = await cb(tx);
        // Commit only if the doc version hasn't moved.
        if (readVersion === docState.version) {
          for (const payload of pendingUpdates) {
            docState.data = { ...docState.data, ...payload };
          }
          if (pendingUpdates.length > 0) {
            docState.version++;
          }
          return result;
        }
        // Stale — retry with the new state.
      }
      throw new Error('transaction failed after retries');
    },
  }),
}));

import { POST } from '@/app/api/mfa/verify-login/route';
import { createMockRequest } from '../helpers/utils';

beforeEach(() => {
  jest.clearAllMocks();
  // Two backup codes, both valid.
  docState = {
    version: 0,
    exists: true,
    data: {
      mfaEnrolled: true,
      backupCodes: ['hash-bk-1', 'hash-bk-2'],
    },
  };
  txOpsLog = [];

  mockRequireSessionUser.mockResolvedValue('user-1');
  mockAssertActiveUser.mockImplementation(async () => {
    if (!docState.exists) {
      const { ApiAuthError } = jest.requireMock(
        '@/lib/apiAuth.server',
      ) as { ApiAuthError: new (status: number, message: string) => Error };
      throw new ApiAuthError(403, 'Forbidden: User is deleted or inactive');
    }
    return docState.data;
  });
  mockVerifyTOTP.mockReturnValue(false);
  // Only hash-bk-1 (the code under contention) matches.
  mockVerifyBackupCode.mockImplementation(
    (_code: string, hash: string) => hash === 'hash-bk-1',
  );

  // Device-trust defaults: fixed token pair, persistence resolves.
  mockMintDeviceTrustToken.mockReturnValue({
    raw: 'raw-token-123',
    hash: 'hash-token-123',
  });
  mockCreateTrustedDevice.mockResolvedValue(undefined);
});

function verifyReq() {
  return createMockRequest('http://localhost/api/mfa/verify-login', {
    method: 'POST',
    body: {
      userId: 'user-1',
      code: 'AAAA-BBBB',
      isBackupCode: true,
    },
  });
}

describe('POST /api/mfa/verify-login — backup code single-use under concurrency', () => {
  it('two parallel calls with the same backup code: exactly one succeeds, one fails', async () => {
    const [resA, resB] = await Promise.all([
      POST(verifyReq()),
      POST(verifyReq()),
    ]);

    const codes: number[] = [resA.status, resB.status];
    // One 200, one 400: the retrying call sees only hash-bk-2, which won't match.
    expect(codes.filter((c) => c === 200).length).toBe(1);
    expect(codes.filter((c) => c === 400).length).toBe(1);

    // hash-bk-1 was consumed; only hash-bk-2 remains.
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);
  });

  it('a single sequential call still consumes correctly', async () => {
    // Control: serial behaviour.
    const r1 = await POST(verifyReq());
    expect(r1.status).toBe(200);
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);

    // No trustDevice in the body → no mint, no Set-Cookie.
    expect(mockMintDeviceTrustToken).not.toHaveBeenCalled();
    expect(mockCreateTrustedDevice).not.toHaveBeenCalled();
    expect(r1.cookies.get(TRUST_COOKIE)).toBeUndefined();

    // Replay fails — the code is consumed.
    const r2 = await POST(verifyReq());
    expect(r2.status).toBe(400);
    expect(docState.data.backupCodes).toEqual(['hash-bk-2']);
  });
});

describe('POST /api/mfa/verify-login — device trust ("remember this device")', () => {
  const USER_AGENT = 'jest-test-agent';

  function totpReq(overrides: Record<string, unknown> = {}) {
    return createMockRequest('http://localhost/api/mfa/verify-login', {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT },
      body: {
        userId: 'user-1',
        code: '123456',
        ...overrides,
      },
    });
  }

  beforeEach(() => {
    // A colon-free mfaSecret takes the legacy "use as-is" branch, so verifyTOTP
    // runs directly and no decrypt mock is needed.
    docState.data.mfaSecret = 'PLAINSECRET';
    mockVerifyTOTP.mockReturnValue(true);
  });

  it('(a) trustDevice:true + valid TOTP → persists device, sets cookie, deviceTrusted:true', async () => {
    const res = await POST(totpReq({ trustDevice: true }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true, deviceTrusted: true });

    expect(mockCreateTrustedDevice).toHaveBeenCalledTimes(1);
    expect(mockCreateTrustedDevice).toHaveBeenCalledWith(
      'user-1',
      'hash-token-123',
      USER_AGENT,
      expect.any(Number),
    );

    expect(res.cookies.get(TRUST_COOKIE)?.value).toBe('raw-token-123');
  });

  it('(b) trustDevice:false → no mint, no cookie, deviceTrusted:false', async () => {
    const res = await POST(totpReq({ trustDevice: false }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deviceTrusted).toBe(false);
    expect(mockMintDeviceTrustToken).not.toHaveBeenCalled();
    expect(mockCreateTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get(TRUST_COOKIE)).toBeUndefined();
  });

  it('(b) trustDevice omitted → no mint, no cookie, deviceTrusted:false', async () => {
    const res = await POST(totpReq());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deviceTrusted).toBe(false);
    expect(mockMintDeviceTrustToken).not.toHaveBeenCalled();
    expect(mockCreateTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get(TRUST_COOKIE)).toBeUndefined();
  });

  it('(b) truthy-but-non-strict trustDevice (string "true") is treated as false', async () => {
    const res = await POST(totpReq({ trustDevice: 'true' }));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.deviceTrusted).toBe(false);
    expect(mockMintDeviceTrustToken).not.toHaveBeenCalled();
    expect(mockCreateTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get(TRUST_COOKIE)).toBeUndefined();
  });

  it('(c) trustDevice:true + INVALID code → 400, no mint, no cookie', async () => {
    mockVerifyTOTP.mockReturnValue(false);

    const res = await POST(totpReq({ trustDevice: true }));
    expect(res.status).toBe(400);
    expect(mockMintDeviceTrustToken).not.toHaveBeenCalled();
    expect(mockCreateTrustedDevice).not.toHaveBeenCalled();
    expect(res.cookies.get(TRUST_COOKIE)).toBeUndefined();
  });

  it('(d) createTrustedDevice rejects → 200, deviceTrusted:false, no cookie, verification still succeeds', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    mockCreateTrustedDevice.mockRejectedValue(new Error('firestore down'));

    const res = await POST(totpReq({ trustDevice: true }));
    expect(res.status).toBe(200);

    const body = await res.json();
    // 2FA must still succeed; only trust persistence failed.
    expect(body.success).toBe(true);
    expect(body.deviceTrusted).toBe(false);

    // Minted, persistence failed, no cookie set.
    expect(mockMintDeviceTrustToken).toHaveBeenCalledTimes(1);
    expect(res.cookies.get(TRUST_COOKIE)).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('still marks the session mfa-verified when trusting the device', async () => {
    await POST(totpReq({ trustDevice: true }));
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/mfa/verify-login — the network the ceremony ran on', () => {
  afterEach(() => {
    delete process.env.EDGE_SHARED_SECRET;
  });

  it('is stamped on the login session, for swoop to bind the ceremony to', async () => {
    process.env.EDGE_SHARED_SECRET = 'edge-secret-for-tests';
    docState.data.mfaSecret = 'PLAINSECRET';
    mockVerifyTOTP.mockReturnValue(true);

    const res = await POST(
      createMockRequest('http://localhost/api/mfa/verify-login', {
        method: 'POST',
        headers: { 'x-owlette-edge': 'edge-secret-for-tests', 'x-owlette-asn': '64500' },
        body: { userId: 'user-1', code: '123456' },
      }),
    );

    expect(res.status).toBe(200);
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledWith('asn:64500');
  });
});
