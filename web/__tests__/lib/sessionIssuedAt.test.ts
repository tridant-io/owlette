/** @jest-environment node */

/**
 * The login cookie's `issuedAt`: stamped when a session is minted, and re-stamped by the
 * session that changes a factor, so it outlives the cutoff its own change sets. A session from
 * before the cutoff carries no verified second factor into the next one.
 */

type MutableSession = Record<string, unknown> & { save: jest.Mock; destroy: jest.Mock };

let session: MutableSession;
let userDoc: Record<string, unknown>;
/** firebase token revocations by uid */
const revokedAt = new Map<string, number>();

jest.mock('iron-session', () => ({
  getIronSession: jest.fn(async () => session),
}));

jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ get: () => undefined })),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    getUser: async (uid: string) =>
      revokedAt.has(uid) ? { tokensValidAfterTime: new Date(revokedAt.get(uid)!).toUTCString() } : {},
  }),
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => userDoc }) }),
    }),
  }),
}));

jest.mock('@/lib/deviceTrust.server', () => ({
  DEVICE_TRUST_COOKIE: 'owlette_device_trust',
  findValidTrustedDevice: jest.fn(async () => false),
}));

import {
  createSession,
  keepSessionPastCutoff,
  markSessionMfaDisabled,
  markSessionMfaVerified,
} from '@/lib/sessionManager.server';

const HOUR = 60 * 60 * 1000;

function makeSession(fields: Record<string, unknown>): MutableSession {
  return { ...fields, save: jest.fn(async () => {}), destroy: jest.fn(async () => {}) };
}

/** a verified session minted `ageMs` ago */
function verified(ageMs: number, userId = 'u1') {
  const issuedAt = Date.now() - ageMs;
  return makeSession({
    userId,
    issuedAt,
    expiresAt: issuedAt + 7 * 24 * HOUR,
    mfaRequired: true,
    mfaVerified: true,
    mfaCompletedAt: issuedAt,
    mfaSatisfiedBy: 'challenge',
  });
}

beforeEach(() => {
  userDoc = { mfaEnrolled: true, requiresMfaSetup: false };
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('createSession', () => {
  it('stamps issuedAt, and keeps the verified state of a session minted after the cutoff', async () => {
    userDoc.sessionsValidAfter = Date.now() - 2 * HOUR;
    session = verified(HOUR);
    const before = Date.now();
    await createSession('u1');
    expect(session.issuedAt).toBeGreaterThanOrEqual(before);
    expect(session.mfaVerified).toBe(true);
  });

  it('asks again for the second factor when the session it replaces predates the cutoff', async () => {
    userDoc.sessionsValidAfter = Date.now() - HOUR;
    session = verified(2 * HOUR);
    await createSession('u1');
    expect(session.mfaVerified).toBe(false);
  });

  it('asks again when the session it replaces predates a password reset', async () => {
    revokedAt.set('u-reset', Date.now() - HOUR);
    session = verified(2 * HOUR, 'u-reset');
    await createSession('u-reset');
    expect(session.mfaVerified).toBe(false);
  });
});

describe('the session that changed a factor', () => {
  it.each([
    ['markSessionMfaVerified', () => markSessionMfaVerified()],
    ['markSessionMfaDisabled', () => markSessionMfaDisabled()],
    ['keepSessionPastCutoff', () => keepSessionPastCutoff('u1')],
  ])('is re-stamped by %s', async (_name, run) => {
    session = verified(HOUR);
    const before = Date.now();
    await run();
    expect(session.issuedAt).toBeGreaterThanOrEqual(before);
    expect(session.save).toHaveBeenCalled();
  });

  it('is left alone when the change was to someone else', async () => {
    session = verified(HOUR);
    const issuedAt = session.issuedAt;
    await keepSessionPastCutoff('someone-else');
    expect(session.issuedAt).toBe(issuedAt);
    expect(session.save).not.toHaveBeenCalled();
  });
});
