/** @jest-environment node */

/**
 * A login cookie someone else holds stops working once the account resets its password or
 * changes a factor, and an account that never did either keeps every session it has.
 * Real `requireSession` and real factor writer; the cookie, the clock and the Firebase user
 * record are the inputs.
 */

import { NextRequest } from 'next/server';

const DAY = 24 * 60 * 60 * 1000;

let clock: number;
let uid: string;
let cookie: Record<string, unknown>;
/** Firebase user records by uid; a thrown error stands for an Auth outage. */
const authUsers = new Map<string, { tokensValidAfterTime?: string } | Error>();
const users = new Map<string, Record<string, unknown>>();

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: async () => cookie,
  getSessionData: async () => null,
}));

jest.mock('@/lib/firebase-admin', () => {
  const snap = (id: string) => ({
    exists: users.has(id),
    data: () => (users.has(id) ? { ...users.get(id) } : undefined),
  });
  const merge = (id: string, payload: Record<string, unknown>) =>
    users.set(id, { ...(users.get(id) ?? {}), ...payload });
  const ref = (id: string) => ({
    id,
    get: async () => snap(id),
    collection: () => ({ get: async () => ({ size: 0 }) }),
  });
  return {
    getAdminAuth: () => ({
      getUser: async (id: string) => {
        const record = authUsers.get(id);
        if (record instanceof Error) throw record;
        return record ?? {};
      },
    }),
    getAdminDb: () => ({
      collection: () => ({ doc: (id: string) => ref(id) }),
      runTransaction: async <T>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
        cb({
          get: async (r: { id?: string; get: () => Promise<unknown> }) => (r.id ? snap(r.id) : r.get()),
          update: (r: { id: string }, payload: Record<string, unknown>) => merge(r.id, payload),
          set: (r: { id: string }, payload: Record<string, unknown>) => merge(r.id, payload),
        }),
    }),
  };
});

import { requireSession } from '@/lib/apiAuth.server';
import { applyMfaFactorChange } from '@/lib/mfaFactors.server';

const api = () => new NextRequest(new URL('http://localhost/api/keys'));

/** a verified cookie minted `ageMs` ago, the way a stolen one would be */
function verifiedCookie(ageMs: number) {
  const issuedAt = clock - ageMs;
  return {
    userId: uid,
    issuedAt,
    expiresAt: issuedAt + 7 * DAY,
    mfaRequired: true,
    mfaVerified: true,
    mfaCompletedAt: issuedAt,
    mfaSatisfiedBy: 'challenge',
    destroy: jest.fn(),
  };
}

/** firebase revokes the account's tokens, as a password reset or change does */
function resetPassword(at = clock) {
  authUsers.set(uid, { tokensValidAfterTime: new Date(at).toUTCString() });
}

let nextUid = 0;
beforeEach(() => {
  clock = Date.UTC(2026, 10, 11, 12, 0, 0);
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  // a new account per test: the revocation cache outlives a test
  uid = `u${++nextUid}`;
  users.set(uid, {
    email: `${uid}@example.com`,
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: true, passkeys: 1 },
  });
  // created a month ago and never revoked since
  authUsers.set(uid, { tokensValidAfterTime: new Date(clock - 30 * DAY).toUTCString() });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a password reset', () => {
  it('ends a cookie minted before it within a minute, with no sign-in in between', async () => {
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).resolves.toBe(uid);

    resetPassword();
    clock += 61_000;

    await expect(requireSession(api())).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  });

  it('ends it at once on an instance that has not looked the account up yet', async () => {
    resetPassword(clock - 60_000);
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  });

  it('leaves a cookie minted after it alone', async () => {
    resetPassword(clock - 2 * 60 * 60 * 1000);
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).resolves.toBe(uid);
  });

  it('leaves every session alone on an account that never had one', async () => {
    cookie = verifiedCookie(6 * DAY);
    await expect(requireSession(api())).resolves.toBe(uid);
  });

  it('dates a cookie from before the field existed by its expiry', async () => {
    resetPassword(clock - 60_000);
    cookie = verifiedCookie(60 * 60 * 1000);
    delete (cookie as { issuedAt?: number }).issuedAt;
    await expect(requireSession(api())).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  });
});

describe('when the Auth lookup fails', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('lets the session through when nothing is cached, and says so', async () => {
    authUsers.set(uid, new Error('auth unavailable'));
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).resolves.toBe(uid);
    expect(console.error).toHaveBeenCalled();
  });

  it('keeps refusing on the last value it had', async () => {
    resetPassword(clock - 60_000);
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).rejects.toMatchObject({ status: 401 });

    authUsers.set(uid, new Error('auth unavailable'));
    clock += 61_000;
    await expect(requireSession(api())).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  });
});

describe('a factor change', () => {
  it('ends a cookie minted before it', async () => {
    cookie = verifiedCookie(60 * 60 * 1000);
    await expect(requireSession(api())).resolves.toBe(uid);

    await applyMfaFactorChange(uid, { totp: false });

    await expect(requireSession(api())).rejects.toMatchObject({ status: 401, code: 'session_revoked' });
  });

  it('leaves the session minted after it alone', async () => {
    await applyMfaFactorChange(uid, { totp: false });
    cookie = verifiedCookie(-1);
    await expect(requireSession(api())).resolves.toBe(uid);
  });
});

describe('first logins', () => {
  it('a session before the user doc exists is not refused', async () => {
    users.delete(uid);
    cookie = verifiedCookie(60_000);
    await expect(requireSession(api())).resolves.toBe(uid);
  });
});
