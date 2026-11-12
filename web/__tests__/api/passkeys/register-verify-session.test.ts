/** @jest-environment node */

/**
 * `/api/passkeys/register/verify`: factor inventory, enrollment gate, and
 * first-factor session promotion. Three invariants:
 *
 *   1. First factor flips `mfaEnrolled`/`requiresMfaSetup` via
 *      `applyMfaFactorChange` AND promotes the session. Without the promotion,
 *      a passkey-only signup bounces to /verify-2fa with nothing to present.
 *   2. Later factors must NOT re-promote — the ceremony substitutes for a
 *      challenge exactly once.
 *   3. `/api/*` is not MFA-gated, so an unchallenged session on an account that
 *      already has a factor must 403 `mfa_challenge_required` before the
 *      challenge is consumed — otherwise it could enroll its own credential
 *      and step up with it.
 *
 * `lib/mfaFactors.server.ts` is deliberately NOT mocked: the assertions are
 * about the fields the real single-writer lands on the user doc.
 */

// Mutable state behind the mocked admin SDK; reset in beforeEach.
let users: Map<string, Record<string, unknown>>;
let passkeys: Map<string, string[]>;

const setCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];

const mockRequireSessionUser = jest.fn();
const mockAssertActiveUser = jest.fn();
const mockGetSessionData = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();
const mockKeepSessionPastCutoff = jest.fn();
const mockGetAndDeleteChallenge = jest.fn();
const mockStorePasskey = jest.fn();
const mockVerifyRegistrationResponse = jest.fn();
const mockEmitMutation = jest.fn();

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
  // Inline: jest hoists this factory above module-scope class initialisation.
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
  keepSessionPastCutoff: (...a: unknown[]) => mockKeepSessionPastCutoff(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'localhost',
  getExpectedOrigins: () => ['http://localhost:3000'],
  getAndDeleteChallenge: (...a: unknown[]) => mockGetAndDeleteChallenge(...a),
  storePasskey: (...a: unknown[]) => mockStorePasskey(...a),
}));

jest.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...a: unknown[]) =>
    mockVerifyRegistrationResponse(...a),
}));

jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { fromBuffer: () => 'public-key-b64url' },
}));

jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
}));

// Store-backed so the real `applyMfaFactorChange` runs and the payload
// assertions below are the route's actual write.
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

import { POST } from '@/app/api/passkeys/register/verify/route';
import { createMockRequest } from '../helpers/utils';

const UID = 'user-1';
const VERIFIED_SESSION = { userId: UID, mfaRequired: true, mfaVerified: true, mfaCompletedAt: 1 };
const NEW_CREDENTIAL_ID = 'cred-new';

beforeEach(() => {
  jest.clearAllMocks();
  users = new Map([[UID, { email: 'owner@example.test' }]]);
  mockSendEmail.mockResolvedValue({ error: null });
  passkeys = new Map([[UID, []]]);
  setCalls.length = 0;

  mockRequireSessionUser.mockResolvedValue(UID);
  mockAssertActiveUser.mockImplementation(async () => users.get(UID) ?? {});
  // Unchallenged by default; zero-factor cases must still pass (setup path).
  mockGetSessionData.mockResolvedValue({ userId: UID, expiresAt: Date.now() + 1000 });
  mockMarkSessionMfaVerified.mockResolvedValue(undefined);
  mockGetAndDeleteChallenge.mockResolvedValue({
    challenge: 'challenge-1',
    userId: UID,
    type: 'registration',
  });
  // Must land in the subcollection — that's what `recountPasskeys` reads.
  mockStorePasskey.mockImplementation(async (uid: string, credential: { credentialId: string }) => {
    passkeys.set(uid, [...(passkeys.get(uid) ?? []), credential.credentialId]);
  });
  mockVerifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: {
        id: NEW_CREDENTIAL_ID,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: ['internal'],
      },
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
    },
  });
});

function registerReq() {
  return createMockRequest('http://localhost/api/passkeys/register/verify', {
    method: 'POST',
    body: { userId: UID, credential: { id: NEW_CREDENTIAL_ID }, friendlyName: 'macbook' },
  });
}

/** The single inventory write the route makes, via `applyMfaFactorChange`. */
function inventoryWrite() {
  return setCalls.find((c) => 'mfaEnrolled' in c.payload);
}

describe('POST /api/passkeys/register/verify — first factor', () => {
  it('enrolls the first passkey, flips the inventory, and promotes the session', async () => {
    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, credentialId: NEW_CREDENTIAL_ID });

    const write = inventoryWrite();
    expect(write).toBeTruthy();
    expect(write!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });

    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const audit = mockEmitMutation.mock.calls[0][0];
    expect(audit.kind).toBe('user_mutated');
    expect(audit.actor).toBe(`user:${UID}`);
    expect(audit.attributes).toMatchObject({
      verb: 'passkey_added',
      credentialId: NEW_CREDENTIAL_ID,
      passkeyCount: 1,
      firstFactor: true,
    });
  });

  it("tells the account's own address a passkey was added", async () => {
    const res = await POST(registerReq());
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      to: 'owner@example.test',
      subject: 'passkey added to your owlette account',
    });
  });

  it('still succeeds when the send fails', async () => {
    mockSendEmail.mockRejectedValue(new Error('resend down'));

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(mockStorePasskey).toHaveBeenCalledTimes(1);
  });

  it('counts the subcollection rather than trusting a stale stored tally', async () => {
    // Doc claims zero passkeys while one exists: recount must yield 2.
    users.set(UID, { mfaFactors: { totp: false, passkeys: 0 } });
    passkeys.set(UID, ['cred-old']);
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
    });
  });
});

describe('POST /api/passkeys/register/verify — subsequent factors', () => {
  it('does not re-promote the session for a second passkey', async () => {
    users.set(UID, {
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    passkeys.set(UID, ['cred-old']);
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await POST(registerReq());
    expect(res.status).toBe(200);

    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: false, passkeys: 2 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
      sessionsValidAfter: expect.any(Number),
    });
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
    // the session that added it outlives the cutoff the change set
    expect(mockKeepSessionPastCutoff).toHaveBeenCalledWith(UID);
    expect(mockEmitMutation.mock.calls[0][0].attributes.firstFactor).toBe(false);
  });

  it('does not promote when TOTP already satisfies MFA', async () => {
    // First PASSKEY but not first FACTOR — no promotion.
    users.set(UID, {
      mfaFactors: { totp: true, passkeys: 0 },
      mfaEnrolled: true,
    });
    mockGetSessionData.mockResolvedValue(VERIFIED_SESSION);

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(inventoryWrite()!.payload).toMatchObject({
      mfaFactors: { totp: true, passkeys: 1 },
      mfaEnrolled: true,
    });
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
  });
});

describe('POST /api/passkeys/register/verify — enrollment gate', () => {
  it('rejects an unverified session when a factor already exists', async () => {
    users.set(UID, {
      mfaFactors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
    });
    passkeys.set(UID, ['cred-old']);
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaRequired: true, mfaVerified: false });

    const res = await POST(registerReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');

    // Refused before consuming the ceremony or persisting anything.
    expect(mockGetAndDeleteChallenge).not.toHaveBeenCalled();
    expect(mockStorePasskey).not.toHaveBeenCalled();
    expect(setCalls).toEqual([]);
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
    expect(mockEmitMutation).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('rejects a sign-in from before the account held a factor', async () => {
    users.set(UID, { mfaFactors: { totp: true, passkeys: 0 }, mfaEnrolled: true });
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaRequired: false, mfaVerified: true });

    const res = await POST(registerReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockStorePasskey).not.toHaveBeenCalled();
  });

  it('rejects when there is no session data at all', async () => {
    users.set(UID, { mfaFactors: { totp: true, passkeys: 0 }, mfaEnrolled: true });
    mockGetSessionData.mockResolvedValue(null);

    const res = await POST(registerReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
    expect(mockStorePasskey).not.toHaveBeenCalled();
  });

  it('stays open for a zero-factor account on an unverified session', async () => {
    // Mandatory-setup path: nothing to challenge against.
    mockGetSessionData.mockResolvedValue({ userId: UID, mfaVerified: false });

    const res = await POST(registerReq());
    expect(res.status).toBe(200);
    expect(mockStorePasskey).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionMfaVerified).toHaveBeenCalledTimes(1);
  });
});
