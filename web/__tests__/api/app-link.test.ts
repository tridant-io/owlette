/** @jest-environment node */

/**
 * The app-link routes end to end against an in-memory firestore: mint / start / approve /
 * exchange, single use, expiry, the poll secret, and the claim /api/auth/session reads back.
 */

import crypto from 'crypto';
import { NextRequest } from 'next/server';
import type { DecodedIdToken } from 'firebase-admin/auth';

interface MockSession {
  userId?: string;
  expiresAt?: number;
  mfaVerified?: boolean;
  mfaSatisfiedBy?: string;
  mfaCompletedAt?: number;
  mfaNetwork?: string;
}

const mockStore = new Map<string, Record<string, unknown>>();
let mockSession: MockSession = {};
const mockCreateCustomToken = jest.fn();

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
  getUserIdFromSession: jest.fn(),
}));

jest.mock('@/lib/sessionManager.server', () => ({
  getSessionFromRequest: async () => mockSession,
  getSessionData: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
    now: () => {
      const ms = Date.now();
      return { toMillis: () => ms };
    },
  },
  FieldValue: { serverTimestamp: jest.fn(), delete: jest.fn() },
}));

jest.mock('@/lib/firebase-admin', () => {
  const snapshot = (key: string) => {
    const data = mockStore.get(key);
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  };
  const docRef = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    return {
      id,
      key,
      get: async () => snapshot(key),
      create: async (data: Record<string, unknown>) => {
        if (mockStore.has(key)) throw new Error('ALREADY_EXISTS');
        mockStore.set(key, { ...data });
      },
    };
  };
  type Ref = ReturnType<typeof docRef>;
  return {
    getAdminAuth: () => ({
      createCustomToken: (...args: unknown[]) => mockCreateCustomToken(...args),
    }),
    getAdminDb: () => ({
      collection: (collection: string) => ({ doc: (id: string) => docRef(collection, id) }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const writes: Array<() => void> = [];
        const result = await fn({
          get: async (ref: Ref) => snapshot(ref.key),
          update: (ref: Ref, patch: Record<string, unknown>) =>
            writes.push(() => mockStore.set(ref.key, { ...mockStore.get(ref.key), ...patch })),
          delete: (ref: Ref) => writes.push(() => mockStore.delete(ref.key)),
        });
        writes.forEach((write) => write());
        return result;
      },
    }),
  };
});

import { POST as mint } from '@/app/api/auth/app-link/route';
import { POST as start } from '@/app/api/auth/app-link/start/route';
import { POST as approve } from '@/app/api/auth/app-link/approve/route';
import { POST as exchange } from '@/app/api/auth/app-link/exchange/route';
import {
  APP_LINK_APPROVED_TTL_MS,
  APP_LINK_CLAIM_MAX_AGE_MS,
  APP_LINK_PENDING_TTL_MS,
  appLinkMfaFromIdToken,
} from '@/lib/appLink.server';

const BASE = 1_800_000_000_000;
/** when the approving browser passed its second factor: before it approved, not at it. */
const CEREMONY_AT = BASE - 90_000;

function post(path: string, body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const record = (code: string) =>
  mockStore.get(`app_links/${crypto.createHash('sha256').update(code).digest('hex')}`);

function signedIn(overrides: MockSession = {}): void {
  mockSession = {
    userId: 'user-1',
    expiresAt: Date.now() + 60_000,
    mfaVerified: true,
    mfaSatisfiedBy: 'challenge',
    mfaCompletedAt: CEREMONY_AT,
    ...overrides,
  };
}

async function mintCode(): Promise<string> {
  const res = await mint(post('/api/auth/app-link'));
  expect(res.status).toBe(201);
  return (await res.json()).code;
}

async function startCode(): Promise<{ code: string; secret: string }> {
  const res = await start(post('/api/auth/app-link/start'));
  expect(res.status).toBe(201);
  return res.json();
}

let now = BASE;

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockStore.set('users/user-1', { role: 'member' });
  now = BASE;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  signedIn();
  mockCreateCustomToken.mockResolvedValue('custom-token');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('POST /api/auth/app-link (mint)', () => {
  it('mints an approved 60 s code for the caller, stored only as its hash', async () => {
    const res = await mint(post('/api/auth/app-link'));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(BASE + APP_LINK_APPROVED_TTL_MS);
    expect(body).not.toHaveProperty('uid');

    const stored = record(body.code);
    expect(stored).toMatchObject({
      status: 'approved',
      uid: 'user-1',
      mfaSatisfiedBy: 'challenge',
      mfaCompletedAt: CEREMONY_AT,
    });
    expect(Object.values(stored ?? {})).not.toContain(body.code);
  });

  it('refuses without a login cookie', async () => {
    mockSession = {};
    const res = await mint(post('/api/auth/app-link'));
    expect(res.status).toBe(401);
    expect(mockStore.size).toBe(1);
  });

  it('refuses an expired login cookie', async () => {
    signedIn({ expiresAt: BASE - 1 });
    const res = await mint(post('/api/auth/app-link'));
    expect(res.status).toBe(401);
  });

  it('refuses a session whose mfa challenge is still pending', async () => {
    signedIn({ mfaVerified: false, mfaSatisfiedBy: undefined });
    const res = await mint(post('/api/auth/app-link'));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('mfa_challenge_required');
  });

  it('refuses a deleted user', async () => {
    mockStore.set('users/user-1', { deletedAt: BASE });
    const res = await mint(post('/api/auth/app-link'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/app-link/exchange', () => {
  it('trades an approved code for a custom token carrying the approver mfa, once', async () => {
    const code = await mintCode();

    const res = await exchange(post('/api/auth/app-link/exchange', { code }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ customToken: 'custom-token' });
    expect(mockCreateCustomToken).toHaveBeenCalledWith('user-1', {
      appLinkMfa: 'challenge',
      appLinkMfaAt: CEREMONY_AT,
    });
    expect(record(code)).toMatchObject({ status: 'used' });

    const reuse = await exchange(post('/api/auth/app-link/exchange', { code }));
    expect(reuse.status).toBe(410);
    expect(mockCreateCustomToken).toHaveBeenCalledTimes(1);
  });

  // swoop's network binding lets that ceremony stand in only on the network it ran on
  it('carries the network the approver passed its second factor on', async () => {
    signedIn({ mfaNetwork: 'asn:64500' });
    const code = await mintCode();
    await exchange(post('/api/auth/app-link/exchange', { code }));
    expect(mockCreateCustomToken).toHaveBeenCalledWith('user-1', {
      appLinkMfa: 'challenge',
      appLinkMfaAt: CEREMONY_AT,
      appLinkMfaNet: 'asn:64500',
    });
  });

  it('leaves the ceremony time out for an approver session that has none', async () => {
    signedIn({ mfaCompletedAt: undefined });
    const code = await mintCode();
    await exchange(post('/api/auth/app-link/exchange', { code }));
    expect(mockCreateCustomToken).toHaveBeenCalledWith('user-1', { appLinkMfa: 'challenge' });
  });

  it('mints a claimless token for an approver with no mfa', async () => {
    signedIn({ mfaSatisfiedBy: undefined });
    const code = await mintCode();
    await exchange(post('/api/auth/app-link/exchange', { code }));
    expect(mockCreateCustomToken).toHaveBeenCalledWith('user-1', undefined);
  });

  it('answers 410 once the code has expired, and forgets it', async () => {
    const code = await mintCode();
    now = BASE + APP_LINK_APPROVED_TTL_MS;

    const res = await exchange(post('/api/auth/app-link/exchange', { code }));
    expect(res.status).toBe(410);
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
    expect(record(code)).toBeUndefined();
  });

  it('answers 404 for an unknown code and 400 for none', async () => {
    expect((await exchange(post('/api/auth/app-link/exchange', { code: 'nope' }))).status).toBe(404);
    expect((await exchange(post('/api/auth/app-link/exchange', {}))).status).toBe(400);
  });
});

describe('POST /api/auth/app-link/start + approve + exchange (cold start)', () => {
  it('mints a pending 10 min code with a hashed poll secret', async () => {
    const res = await start(post('/api/auth/app-link/start'));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.approveUrl).toBe(`/app-link/approve?code=${body.code}`);
    expect(body.expiresAt).toBe(BASE + APP_LINK_PENDING_TTL_MS);

    const stored = record(body.code);
    expect(stored).toMatchObject({ status: 'pending' });
    expect(stored?.secretHash).toBe(crypto.createHash('sha256').update(body.secret).digest('hex'));
    expect(Object.values(stored ?? {})).not.toContain(body.secret);
  });

  it('polls pending with the secret, then hands over the token once approved', async () => {
    const { code, secret } = await startCode();

    const pending = await exchange(post('/api/auth/app-link/exchange', { code, secret }));
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: 'pending' });

    signedIn({ mfaSatisfiedBy: 'passkey-uv' });
    const approved = await approve(post('/api/auth/app-link/approve', { code }));
    expect(approved.status).toBe(200);
    expect(record(code)).toMatchObject({
      status: 'approved',
      uid: 'user-1',
      mfaSatisfiedBy: 'passkey-uv',
      mfaCompletedAt: CEREMONY_AT,
    });

    const res = await exchange(post('/api/auth/app-link/exchange', { code, secret }));
    expect(res.status).toBe(200);
    expect(mockCreateCustomToken).toHaveBeenCalledWith('user-1', {
      appLinkMfa: 'passkey-uv',
      appLinkMfaAt: CEREMONY_AT,
    });
  });

  it('answers nothing for a started code without its secret, approved or not', async () => {
    const { code } = await startCode();

    expect((await exchange(post('/api/auth/app-link/exchange', { code }))).status).toBe(404);
    expect(
      (await exchange(post('/api/auth/app-link/exchange', { code, secret: 'wrong' }))).status,
    ).toBe(404);

    await approve(post('/api/auth/app-link/approve', { code }));
    expect((await exchange(post('/api/auth/app-link/exchange', { code }))).status).toBe(404);
    expect(record(code)).toMatchObject({ status: 'approved' });
    expect(mockCreateCustomToken).not.toHaveBeenCalled();
  });

  it('answers 410 to the poll once the pending code expires', async () => {
    const { code, secret } = await startCode();
    now = BASE + APP_LINK_PENDING_TTL_MS;
    expect((await exchange(post('/api/auth/app-link/exchange', { code, secret }))).status).toBe(410);
  });

  it('refuses to approve a code that is not pending (409)', async () => {
    const minted = await mintCode();
    expect((await approve(post('/api/auth/app-link/approve', { code: minted }))).status).toBe(409);

    const { code, secret } = await startCode();
    await approve(post('/api/auth/app-link/approve', { code }));
    expect((await approve(post('/api/auth/app-link/approve', { code }))).status).toBe(409);
    await exchange(post('/api/auth/app-link/exchange', { code, secret }));
    expect((await approve(post('/api/auth/app-link/approve', { code }))).status).toBe(409);
  });

  it('answers 404 to approving an unknown or expired code, and 400 to none', async () => {
    expect((await approve(post('/api/auth/app-link/approve', { code: 'nope' }))).status).toBe(404);

    const { code } = await startCode();
    now = BASE + APP_LINK_PENDING_TTL_MS;
    signedIn();
    expect((await approve(post('/api/auth/app-link/approve', { code }))).status).toBe(404);

    expect((await approve(post('/api/auth/app-link/approve', {}))).status).toBe(400);
  });

  it('refuses to approve without a login cookie or with mfa pending', async () => {
    const { code } = await startCode();

    mockSession = {};
    expect((await approve(post('/api/auth/app-link/approve', { code }))).status).toBe(401);

    signedIn({ mfaVerified: false });
    expect((await approve(post('/api/auth/app-link/approve', { code }))).status).toBe(403);

    expect(record(code)).toMatchObject({ status: 'pending' });
  });
});

describe('appLinkMfaFromIdToken', () => {
  const token = (overrides: Record<string, unknown>): DecodedIdToken =>
    ({
      uid: 'user-1',
      auth_time: Math.floor(BASE / 1000),
      firebase: { sign_in_provider: 'custom', identities: {} },
      appLinkMfa: 'challenge',
      appLinkMfaAt: CEREMONY_AT,
      ...overrides,
    }) as unknown as DecodedIdToken;

  it('reads the claims off a fresh custom-token sign-in', () => {
    expect(appLinkMfaFromIdToken(token({}), BASE)).toEqual({
      satisfiedBy: 'challenge',
      completedAt: CEREMONY_AT,
    });
    expect(appLinkMfaFromIdToken(token({ appLinkMfa: 'device-trust' }), BASE)).toEqual({
      satisfiedBy: 'device-trust',
      completedAt: CEREMONY_AT,
    });
  });

  it('reads the ceremony network when the claim carries one', () => {
    expect(appLinkMfaFromIdToken(token({ appLinkMfaNet: 'asn:64500' }), BASE)).toEqual({
      satisfiedBy: 'challenge',
      completedAt: CEREMONY_AT,
      network: 'asn:64500',
    });
    expect(appLinkMfaFromIdToken(token({ appLinkMfaNet: 64500 }), BASE)).not.toHaveProperty('network');
  });

  // the app's session must never look fresher than the ceremony behind it: swoop
  // counts a sign-in ceremony under five minutes old as its step-up.
  it('dates a missing ceremony time at 0 and a future one at now', () => {
    expect(appLinkMfaFromIdToken(token({ appLinkMfaAt: undefined }), BASE)?.completedAt).toBe(0);
    expect(appLinkMfaFromIdToken(token({ appLinkMfaAt: 'soon' }), BASE)?.completedAt).toBe(0);
    expect(appLinkMfaFromIdToken(token({ appLinkMfaAt: BASE + 60_000 }), BASE)?.completedAt).toBe(BASE);
  });

  it('ignores the claim on any other sign-in provider', () => {
    for (const provider of ['password', 'google.com', 'anonymous']) {
      expect(
        appLinkMfaFromIdToken(token({ firebase: { sign_in_provider: provider, identities: {} } }), BASE),
      ).toBeUndefined();
    }
  });

  it('ignores an unknown satisfier and a missing claim', () => {
    expect(appLinkMfaFromIdToken(token({ appLinkMfa: 'totally-verified' }), BASE)).toBeUndefined();
    expect(appLinkMfaFromIdToken(token({ appLinkMfa: undefined }), BASE)).toBeUndefined();
  });

  it('ignores the claim on a refreshed token long after the sign-in', () => {
    expect(appLinkMfaFromIdToken(token({}), BASE + APP_LINK_CLAIM_MAX_AGE_MS)?.satisfiedBy).toBe('challenge');
    expect(appLinkMfaFromIdToken(token({}), BASE + APP_LINK_CLAIM_MAX_AGE_MS + 1000)).toBeUndefined();
  });
});
