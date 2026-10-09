/** @jest-environment node */

/**
 * Route-level tests for POST /api/users/bootstrap — the signup-abuse controls
 * plus the verified-email pin (issue #22). The pure helpers are unit-tested
 * elsewhere; these pin the ROUTE wiring those tests can't see:
 *   - the persisted email is the VERIFIED Firebase Auth email (getUser(uid)),
 *     never body.email, so a bot can't authenticate with a disposable address
 *     and store a clean one (or vice-versa);
 *   - a disposable verified email 400s BEFORE any DB write (bootstrapUser is
 *     never called);
 *   - the per-IP signup limit 429s before the handler runs;
 *   - the bot challenge gates CREATION, not calls — it rides bootstrapUser's
 *     `onWillCreate` hook, which fires only when `users/{uid}` is absent;
 *   - creating an unverified password account sends the verification email,
 *     and a failed send never fails the bootstrap.
 * A regression that re-trusted body.email, dropped the withRateLimit wrap,
 * moved the disposable check after the write, or hoisted the challenge back
 * ahead of the existence read would pass the old tests, not these.
 *
 * bootstrapUser is mocked, so the doc-existence premise each test runs under is
 * stated by which fake it installs — `absentDocBootstrap` or `existingDocBootstrap`.
 */

import { createMockRequest, parseResponse } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// The route reads the AUTHORITATIVE email from getAdminAuth().getUser(uid).
// getAdminDb comes in transitively via apiAuth.server — keep it present.
const mockGetUser = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: (...a: unknown[]) => mockGetUser(...a) }),
  getAdminDb: jest.fn(),
}));

const mockRequireSessionOrIdToken = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    requireSessionOrIdToken: (...a: unknown[]) => mockRequireSessionOrIdToken(...a),
  };
});

const mockBootstrapUser = jest.fn();
jest.mock('@/lib/actions/bootstrapUser.server', () => ({
  bootstrapUser: (...a: unknown[]) => mockBootstrapUser(...a),
}));

// Idempotency wrapper: just run the inner handler (no Firestore cache in tests).
jest.mock('@/lib/idempotency', () => ({
  withIdempotency: (
    _req: unknown,
    _ctx: unknown,
    _raw: unknown,
    handler: () => unknown,
  ) => handler(),
}));

// Control the rate-limit verdict directly (real Upstash/in-memory limiter is
// bypassed). Keep getClientIp / getRateLimitHeaders / limiter consts real.
const mockCheckRateLimit = jest.fn();
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { ...actual, checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a) };
});

// needsEmailVerification stays real, so the provider/verified rule is on trial here.
const mockSendVerificationEmail = jest.fn();
jest.mock('@/lib/emailVerification.server', () => ({
  ...jest.requireActual('@/lib/emailVerification.server'),
  sendVerificationEmail: (...a: unknown[]) => mockSendVerificationEmail(...a),
}));

import { POST } from '@/app/api/users/bootstrap/route';

function bootstrapReq(body: Record<string, unknown>) {
  return createMockRequest('/api/users/bootstrap', { method: 'POST', body });
}

type CreateGate = { ok: true } | { ok: false; reason: string };
interface BootstrapInput {
  onWillCreate?: () => Promise<CreateGate>;
}

/**
 * Stands in for bootstrapUser when `users/{uid}` is ABSENT: it consults the
 * caller's creation gate and honours the verdict, exactly as the real one does
 * between its existence read and its write.
 */
async function absentDocBootstrap(_ctx: unknown, input: BootstrapInput) {
  const verdict = await input.onWillCreate?.();
  if (verdict && !verdict.ok) {
    return { kind: 'create_denied', reason: verdict.reason };
  }
  return {
    kind: 'created',
    uid: 'uid-test',
    email: 'real@gmail.com',
    displayName: '',
    timezone: 'UTC',
    createdAt: 1,
  };
}

/**
 * Stands in for bootstrapUser when `users/{uid}` already EXISTS: it returns on
 * the existence read, so the creation gate is never consulted.
 */
async function existingDocBootstrap() {
  return { kind: 'already_exists', createdAt: 1 };
}

describe('POST /api/users/bootstrap — abuse controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireSessionOrIdToken.mockResolvedValue('uid-test');
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: 'real@gmail.com' });
    // Default premise: a brand-new account, no users/{uid} doc yet.
    mockBootstrapUser.mockImplementation(absentDocBootstrap);
    mockCheckRateLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 9,
      reset: 1_000_000,
    });
  });

  it('rejects when the VERIFIED account email is a disposable domain — even if body.email is clean', async () => {
    // Bot authenticates with a disposable address but POSTs a clean one.
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: 'bot@mailinator.com' });
    const res = await POST(bootstrapReq({ email: 'clean@gmail.com' }));
    const { status, body } = await parseResponse(res);
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/disposable/i);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  it('persists the VERIFIED token email, never the client-supplied body.email', async () => {
    const res = await POST(
      bootstrapReq({ email: 'attacker-controlled@evil.com', displayName: 'Real Person' }),
    );
    const { status } = await parseResponse(res);
    expect(status).toBe(200);
    expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
    const input = mockBootstrapUser.mock.calls[0][1] as { email: string };
    expect(input.email).toBe('real@gmail.com'); // from getUser(uid), not the body
  });

  it('rejects with 400 when the account has no usable verified email', async () => {
    mockGetUser.mockResolvedValue({ uid: 'uid-test', email: undefined });
    const res = await POST(bootstrapReq({ email: 'real@gmail.com' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(400);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  describe('turnstile challenge (provider-gated, creation-only)', () => {
    // The route has two callers: the register form (carries a token) and the
    // AuthContext auth-state listener (cannot). The gate keys off the VERIFIED
    // provider so Google sign-in keeps working — see the route comment. It also
    // only fires on CREATION, so the listener's tokenless retry can recover an
    // account whose first bootstrap failed.
    const REAL_SECRET = '1x0000000000000000000000000000000AA';

    afterEach(() => {
      delete process.env.TURNSTILE_SECRET;
      delete process.env.TURNSTILE_HOSTNAMES;
    });

    it('rejects a password-provider signup that carries no turnstile token', async () => {
      process.env.TURNSTILE_SECRET = REAL_SECRET;
      process.env.TURNSTILE_HOSTNAMES = 'owlette.app';
      mockGetUser.mockResolvedValue({
        uid: 'uid-test',
        email: 'real@gmail.com',
        providerData: [{ providerId: 'password' }],
      });
      // No users/{uid} doc — this IS a creation, so the gate must run.
      mockBootstrapUser.mockImplementation(absentDocBootstrap);

      const res = await POST(bootstrapReq({ displayName: 'Bot' }));
      const { status } = await parseResponse(res);
      expect(status).toBe(403);
      // The gate ran, and denied — nothing was written.
      expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
      expect(await mockBootstrapUser.mock.results[0].value).toEqual({
        kind: 'create_denied',
        reason: 'missing_token',
      });
    });

    it('lets a password account with an EXISTING doc through without a token — the recovery path', async () => {
      // The AuthContext listener cannot carry a token (audit item 9). Gating the
      // CALL rather than the creation 403'd it forever, stranding any account
      // whose first bootstrap failed with no self-service way out.
      process.env.TURNSTILE_SECRET = REAL_SECRET;
      process.env.TURNSTILE_HOSTNAMES = 'owlette.app';
      mockGetUser.mockResolvedValue({
        uid: 'uid-test',
        email: 'real@gmail.com',
        providerData: [{ providerId: 'password' }],
      });
      mockBootstrapUser.mockImplementation(existingDocBootstrap);

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));
      const { status, body } = await parseResponse(res);
      expect(status).toBe(200);
      expect((body as { alreadyExists?: boolean }).alreadyExists).toBe(true);
      expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
    });

    it('lets a google-provider signup through without a token', async () => {
      process.env.TURNSTILE_SECRET = REAL_SECRET;
      process.env.TURNSTILE_HOSTNAMES = 'owlette.app';
      mockGetUser.mockResolvedValue({
        uid: 'uid-test',
        email: 'real@gmail.com',
        providerData: [{ providerId: 'google.com' }],
      });

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));
      const { status } = await parseResponse(res);
      expect(status).toBe(200);
      expect(mockBootstrapUser).toHaveBeenCalledTimes(1);
    });

    it('fails closed when providerData is empty — an unverifiable record still needs the challenge', async () => {
      process.env.TURNSTILE_SECRET = REAL_SECRET;
      process.env.TURNSTILE_HOSTNAMES = 'owlette.app';
      mockGetUser.mockResolvedValue({
        uid: 'uid-test',
        email: 'real@gmail.com',
        providerData: [],
      });
      // No users/{uid} doc — this IS a creation, so the gate must run.
      mockBootstrapUser.mockImplementation(absentDocBootstrap);

      const res = await POST(bootstrapReq({ displayName: 'Unknown' }));
      const { status } = await parseResponse(res);
      expect(status).toBe(403);
      expect(await mockBootstrapUser.mock.results[0].value).toEqual({
        kind: 'create_denied',
        reason: 'missing_token',
      });
    });
  });

  it('returns 429 and never writes when the signup rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      retryAfter: 30,
      limit: 10,
      remaining: 0,
      reset: 1_000_000,
    });
    const res = await POST(bootstrapReq({ email: 'real@gmail.com' }));
    const { status } = await parseResponse(res);
    expect(status).toBe(429);
    expect(mockBootstrapUser).not.toHaveBeenCalled();
  });

  describe('email verification at sign-up', () => {
    const passwordRecord = {
      uid: 'uid-test',
      email: 'real@gmail.com',
      emailVerified: false,
      providerData: [{ providerId: 'password' }],
    };

    beforeEach(() => {
      mockSendVerificationEmail.mockResolvedValue(undefined);
    });

    it('sends the verification email when it creates an unverified password account', async () => {
      mockGetUser.mockResolvedValue(passwordRecord);

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));

      expect(res.status).toBe(200);
      expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1);
      expect(mockSendVerificationEmail).toHaveBeenCalledWith('real@gmail.com');
    });

    it('sends nothing for a google sign-up, which arrives verified', async () => {
      mockGetUser.mockResolvedValue({
        ...passwordRecord,
        emailVerified: true,
        providerData: [{ providerId: 'google.com' }],
      });

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));

      expect(res.status).toBe(200);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('sends nothing when the doc already exists — only the first bootstrap mails', async () => {
      mockGetUser.mockResolvedValue(passwordRecord);
      mockBootstrapUser.mockImplementation(existingDocBootstrap);

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));

      expect(res.status).toBe(200);
      expect(mockSendVerificationEmail).not.toHaveBeenCalled();
    });

    it('still bootstraps when the send fails', async () => {
      mockGetUser.mockResolvedValue(passwordRecord);
      mockSendVerificationEmail.mockRejectedValue(new Error('resend down'));
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await POST(bootstrapReq({ displayName: 'Real Person' }));
      const { status, body } = await parseResponse(res);

      expect(status).toBe(200);
      expect((body as { alreadyExists?: boolean }).alreadyExists).toBe(false);
      error.mockRestore();
    });
  });
});
