/** @jest-environment node */

/**
 * `/api/passkeys/[credentialId]` — renaming and removing a passkey factor.
 *
 * both need a session that has cleared a challenge while the account holds a
 * factor. on such a session, removing the last factor is approved: the account
 * re-arms to `mfaEnrolled: false` + `requiresMfaSetup: true`. because it is
 * momentarily factor-less, every trusted-device record is purged (as
 * `/api/mfa/disable` does) and the cookie expired, otherwise a later re-enroll
 * would inherit trust granted against the deleted credential.
 *
 * `lib/mfaFactors.server.ts` is deliberately NOT mocked: the assertions are
 * about fields that actually land on the user doc, so the real single writer
 * runs against the in-memory admin-SDK mock.
 */

// Mutable state backing the mocked admin SDK; reset in beforeEach.
let users: Map<string, Record<string, unknown>>;
let passkeys: Map<string, string[]>;

const setCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];

const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockDeletePasskey = jest.fn();
const mockRenamePasskey = jest.fn();
const mockRevokeAllTrustedDevices = jest.fn();
const mockEmitMutation = jest.fn();
const mockGetSessionData = jest.fn();
const mockKeepSessionPastCutoff = jest.fn();

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
    requireSessionUser: (...a: unknown[]) => mockRequireSessionUser(...a),
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionData: (...a: unknown[]) => mockGetSessionData(...a),
  keepSessionPastCutoff: (...a: unknown[]) => mockKeepSessionPastCutoff(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  deletePasskey: (...a: unknown[]) => mockDeletePasskey(...a),
  renamePasskey: (...a: unknown[]) => mockRenamePasskey(...a),
}));

// Cookie values match the real module, or the expiry assertions mean nothing.
jest.mock('@/lib/deviceTrust.server', () => ({
  revokeAllTrustedDevices: (...a: unknown[]) => mockRevokeAllTrustedDevices(...a),
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  deviceTrustCookieOptions: () => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  }),
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

function makePasskeyCollectionRef(uid: string) {
  return {
    get: async () => {
      const ids = passkeys.get(uid) ?? [];
      return {
        empty: ids.length === 0,
        size: ids.length,
        docs: ids.map((id) => ({ id, data: () => ({}) })),
      };
    },
  };
}

function makeUserDocRef(uid: string) {
  return {
    id: uid,
    get: async () => ({ exists: users.has(uid), data: () => users.get(uid) }),
    collection: (name: string) => {
      if (name !== 'passkeys') throw new Error(`unexpected subcollection: ${name}`);
      return makePasskeyCollectionRef(uid);
    },
  };
}

function makeTx() {
  return {
    get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
    set: (
      ref: { id: string },
      payload: Record<string, unknown>,
      options?: { merge?: boolean },
    ) => {
      setCalls.push({ id: ref.id, payload });
      const current = users.get(ref.id) ?? {};
      users.set(ref.id, options?.merge ? { ...current, ...payload } : { ...payload });
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
      return { doc: (uid: string) => makeUserDocRef(uid) };
    },
    runTransaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) =>
      fn(makeTx()),
  }),
}));

import { DELETE, PATCH } from '@/app/api/passkeys/[credentialId]/route';
import { createMockRequest } from '../helpers/utils';

const UID = 'user-1';
const CRED = 'cred-1';
const VERIFIED_SESSION = { userId: UID, mfaRequired: true, mfaVerified: true, mfaCompletedAt: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  users = new Map([
    [
      UID,
      {
        email: 'owner@example.test',
        mfaFactors: { totp: false, passkeys: 1 },
        mfaEnrolled: true,
        requiresMfaSetup: false,
      },
    ],
  ]);
  passkeys = new Map([[UID, [CRED]]]);
  setCalls.length = 0;

  mockRequireSessionUser.mockResolvedValue(UID);
  mockAssertActiveUser.mockImplementation(async () => users.get(UID) ?? {});
  // As real `deletePasskey` does — `recountPasskeys` reads the subcollection.
  mockDeletePasskey.mockImplementation(async (uid: string, credentialId: string) => {
    passkeys.set(uid, (passkeys.get(uid) ?? []).filter((id) => id !== credentialId));
  });
  mockRenamePasskey.mockResolvedValue(undefined);
  mockRevokeAllTrustedDevices.mockResolvedValue(0);
  mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);
  mockSendEmail.mockResolvedValue({ error: null });
});

function deleteReq(credentialId = CRED, userId: string | null = UID) {
  const query = userId === null ? '' : `?userId=${encodeURIComponent(userId)}`;
  return createMockRequest(`http://localhost/api/passkeys/${credentialId}${query}`, {
    method: 'DELETE',
  });
}

/** The single inventory write the route makes, via `applyMfaFactorChange`. */
function inventoryWrite() {
  return setCalls.find((c) => 'mfaEnrolled' in c.payload);
}

describe('DELETE /api/passkeys/[credentialId] — last factor', () => {
  it('removes the only passkey and re-arms mandatory setup', async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // The credential is gone from the subcollection.
    expect(passkeys.get(UID)).toEqual([]);

    // Re-armed by the single writer, not by this route.
    const write = inventoryWrite();
    expect(write).toBeTruthy();
    expect(write!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
    expect(users.get(UID)).toMatchObject({
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
  });

  it('revokes device trust and expires the trust cookie', async () => {
    mockRevokeAllTrustedDevices.mockResolvedValue(3);

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);

    expect(mockRevokeAllTrustedDevices).toHaveBeenCalledTimes(1);
    expect(mockRevokeAllTrustedDevices).toHaveBeenCalledWith(UID);

    const cookie = res.cookies.get('owlette_device_trust');
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);

    // The revoked count rides on the single audit emission.
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.actor).toBe(`user:${UID}`);
    expect(audit.attributes).toMatchObject({
      verb: 'passkey_removed',
      credentialId: CRED,
      passkeyCount: 0,
      lastFactorRemoved: true,
      trustedDevicesRevoked: 3,
    });
  });

  it('still succeeds when revocation throws', async () => {
    mockRevokeAllTrustedDevices.mockRejectedValue(new Error('firestore down'));

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);

    // The removal itself stands, and the cookie is expired regardless.
    expect(inventoryWrite()!.payload).toMatchObject({ mfaEnrolled: false });
    expect(res.cookies.get('owlette_device_trust')?.maxAge).toBe(0);
    expect(mockEmitMutation.mock.calls[0][0].attributes.trustedDevicesRevoked).toBe(0);
  });
});

describe('DELETE /api/passkeys/[credentialId] — a factor remains', () => {
  it('leaves MFA enrolled and does not touch device trust when TOTP survives', async () => {
    users.set(UID, {
      mfaFactors: { totp: true, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);

    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: true, passkeys: 0 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    expect(mockRevokeAllTrustedDevices).not.toHaveBeenCalled();
    expect(res.cookies.get('owlette_device_trust')).toBeUndefined();
    expect(mockEmitMutation.mock.calls[0][0].attributes).toMatchObject({
      lastFactorRemoved: false,
      trustedDevicesRevoked: 0,
    });
  });

  it('leaves MFA enrolled when another passkey remains', async () => {
    users.set(UID, {
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    passkeys.set(UID, [CRED, 'cred-2']);

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
      sessionsValidAfter: expect.any(Number),
    });
    expect(mockRevokeAllTrustedDevices).not.toHaveBeenCalled();
    // the session that removed it outlives the cutoff the change set
    expect(mockKeepSessionPastCutoff).toHaveBeenCalledWith(UID);
  });
});

describe('/api/passkeys/[credentialId] — a session that has not cleared a challenge', () => {
  const REFUSED_SESSIONS: Array<[string, unknown]> = [
    ['challenge pending', { userId: UID, mfaRequired: true, mfaVerified: false }],
    ['signed in before the account held a factor', { userId: UID, mfaRequired: false, mfaVerified: true }],
    ['no session data', null],
  ];

  it.each(REFUSED_SESSIONS)('refuses DELETE: %s', async (_label, session) => {
    mockGetSessionData.mockResolvedValue(session);

    const res = await DELETE(deleteReq());

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockDeletePasskey).not.toHaveBeenCalled();
    expect(setCalls).toEqual([]);
    expect(mockRevokeAllTrustedDevices).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(passkeys.get(UID)).toEqual([CRED]);
  });

  it.each(REFUSED_SESSIONS)('refuses PATCH: %s', async (_label, session) => {
    mockGetSessionData.mockResolvedValue(session);

    const res = await PATCH(
      createMockRequest(`http://localhost/api/passkeys/${CRED}`, {
        method: 'PATCH',
        body: { userId: UID, friendlyName: 'work laptop' },
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockRenamePasskey).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('accepts a session that proved a factor at /api/mfa/disable', async () => {
    // that route leaves mfaRequired false until the next session create
    mockGetSessionData.mockResolvedValue({
      userId: UID,
      mfaRequired: false,
      mfaVerified: true,
      mfaCompletedAt: Date.now(),
    });

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(mockDeletePasskey).toHaveBeenCalledWith(UID, CRED);
  });

  it('stays open when the account holds no factor', async () => {
    users.set(UID, { mfaFactors: { totp: false, passkeys: 0 }, mfaEnrolled: false });
    passkeys.set(UID, []);
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaRequired: false, mfaVerified: true });

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    // nothing was there to remove, so nothing to tell the owner about
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/passkeys/[credentialId] — notice email', () => {
  it("tells the account's own address a passkey was removed", async () => {
    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.test',
      subject: 'passkey removed from your owlette account',
    });
  });

  it('still succeeds when the send fails', async () => {
    mockSendEmail.mockRejectedValue(new Error('resend down'));

    const res = await DELETE(deleteReq());
    expect(res.status).toBe(200);
    expect(passkeys.get(UID)).toEqual([]);
  });

  it('sends nothing when the credential was already gone', async () => {
    const res = await DELETE(deleteReq('cred-elsewhere'));
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/passkeys/[credentialId] — validation', () => {
  it('returns 400 without a userId', async () => {
    const res = await DELETE(deleteReq(CRED, null));
    expect(res.status).toBe(400);
    expect(mockDeletePasskey).not.toHaveBeenCalled();
    expect(setCalls).toEqual([]);
  });
});

describe('PATCH /api/passkeys/[credentialId]', () => {
  it('renames the credential and records it', async () => {
    const res = await PATCH(
      createMockRequest(`http://localhost/api/passkeys/${CRED}`, {
        method: 'PATCH',
        body: { userId: UID, friendlyName: 'work laptop' },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockRenamePasskey).toHaveBeenCalledWith(UID, CRED, 'work laptop');

    // A rename touches no factor inventory.
    expect(setCalls).toEqual([]);
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation.mock.calls[0][0].attributes).toMatchObject({
      verb: 'passkey_renamed',
      credentialId: CRED,
    });
  });
});
