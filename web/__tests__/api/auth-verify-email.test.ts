/** @jest-environment node */

/**
 * POST /api/auth/verify-email — the banner's resend. Pins the route wiring:
 * session only (no bearer fallback), the per-user limit checked before any
 * auth-record read or send, the address taken from the caller's own auth
 * record, and the same 204 with no email for accounts that need none.
 */

import { createMockRequest } from './helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockGetUser = jest.fn();
jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ getUser: (...a: unknown[]) => mockGetUser(...a) }),
  getAdminDb: jest.fn(),
}));

const mockRequireSession = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return { ...actual, requireSession: (...a: unknown[]) => mockRequireSession(...a) };
});

const mockCheckRateLimit = jest.fn();
jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { ...actual, checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a) };
});

const mockSendVerificationEmail = jest.fn();
jest.mock('@/lib/emailVerification.server', () => {
  const actual = jest.requireActual('@/lib/emailVerification.server');
  return {
    ...actual,
    sendVerificationEmail: (...a: unknown[]) => mockSendVerificationEmail(...a),
  };
});

import { ApiAuthError } from '@/lib/apiAuth.server';
import { POST } from '@/app/api/auth/verify-email/route';

const UNVERIFIED_PASSWORD_USER = {
  uid: 'uid-test',
  email: 'new@example.com',
  emailVerified: false,
  providerData: [{ providerId: 'password' }],
};

function resendReq() {
  return createMockRequest('/api/auth/verify-email', { method: 'POST' });
}

describe('POST /api/auth/verify-email', () => {
  beforeEach(() => {
    mockRequireSession.mockResolvedValue('uid-test');
    mockGetUser.mockResolvedValue(UNVERIFIED_PASSWORD_USER);
    mockCheckRateLimit.mockResolvedValue({ success: true, limit: 5, remaining: 4, reset: 1_000_000 });
    mockSendVerificationEmail.mockResolvedValue(undefined);
  });

  it('resends to the address on the caller\'s own auth record and returns 204', async () => {
    const res = await POST(resendReq());

    expect(res.status).toBe(204);
    expect(mockGetUser).toHaveBeenCalledWith('uid-test');
    expect(mockSendVerificationEmail).toHaveBeenCalledWith('new@example.com');
  });

  it('rejects a request without a session before reading anything', async () => {
    mockRequireSession.mockRejectedValue(new ApiAuthError(401, 'Unauthorized: No valid session'));

    const res = await POST(resendReq());

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('rate limits per user and sends nothing once the limit is hit', async () => {
    mockCheckRateLimit.mockResolvedValue({
      success: false,
      retryAfter: 600,
      limit: 5,
      remaining: 0,
      reset: 1_000_000,
    });

    const res = await POST(resendReq());

    expect(res.status).toBe(429);
    expect(mockCheckRateLimit.mock.calls[0][1]).toBe('verify_email:uid-test');
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for an account that is already verified', async () => {
    mockGetUser.mockResolvedValue({ ...UNVERIFIED_PASSWORD_USER, emailVerified: true });

    const res = await POST(resendReq());

    expect(res.status).toBe(204);
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for a google-only account', async () => {
    mockGetUser.mockResolvedValue({
      ...UNVERIFIED_PASSWORD_USER,
      providerData: [{ providerId: 'google.com' }],
    });

    const res = await POST(resendReq());

    expect(res.status).toBe(204);
    expect(mockSendVerificationEmail).not.toHaveBeenCalled();
  });

  it('answers a failed send with a generic 500 problem', async () => {
    mockSendVerificationEmail.mockRejectedValue(new Error('resend down'));

    const res = await POST(resendReq());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/resend down/);
  });
});
