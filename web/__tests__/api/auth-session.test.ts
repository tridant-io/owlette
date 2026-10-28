/** @jest-environment node */

import { NextRequest } from 'next/server';

const mockVerifyIdToken = jest.fn();
const mockCreateSession = jest.fn();
const mockUserDocGet = jest.fn();

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (handler: unknown) => handler,
}));

jest.mock('@/lib/sessionManager.server', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  destroySession: jest.fn(),
  getSessionData: jest.fn(),
}));

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
  }),
  getAdminDb: () => ({
    collection: (collectionName: string) => ({
      doc: (docId: string) => ({
        get: () => mockUserDocGet(collectionName, docId),
      }),
    }),
  }),
}));

import { POST } from '@/app/api/auth/session/route';

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({ uid: 'user-1' });
  mockUserDocGet.mockResolvedValue({
    exists: true,
    data: () => ({ role: 'member' }),
  });
});

describe('POST /api/auth/session', () => {
  it('rejects an existing soft-deleted user before creating a session', async () => {
    mockUserDocGet.mockResolvedValue({
      exists: true,
      data: () => ({ deletedAt: Date.now() }),
    });

    const res = await POST(request({ idToken: 'firebase-id-token' }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('User is deleted or inactive');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('allows first login when users doc is not bootstrapped yet', async () => {
    mockUserDocGet.mockResolvedValue({
      exists: false,
      data: () => undefined,
    });

    const res = await POST(request({ idToken: 'firebase-id-token', durationDays: 3 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockCreateSession).toHaveBeenCalledWith('user-1', 3, undefined, undefined, undefined);
  });

  describe('app-link appLinkMfa claim', () => {
    const decoded = (provider: string, claims: Record<string, unknown> = {}) => ({
      uid: 'user-1',
      auth_time: Math.floor(Date.now() / 1000),
      firebase: { sign_in_provider: provider, identities: {} },
      ...claims,
    });

    it('passes the claim and the approver ceremony time to createSession for a custom-token sign-in', async () => {
      const ceremonyAt = Date.now() - 90_000;
      mockVerifyIdToken.mockResolvedValue(
        decoded('custom', { appLinkMfa: 'challenge', appLinkMfaAt: ceremonyAt }),
      );
      const res = await POST(request({ idToken: 'firebase-id-token' }));
      expect(res.status).toBe(200);
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, 'challenge', ceremonyAt, undefined);
    });

    it('passes the network the approver ceremony ran on, for swoop', async () => {
      const ceremonyAt = Date.now() - 90_000;
      mockVerifyIdToken.mockResolvedValue(
        decoded('custom', { appLinkMfa: 'challenge', appLinkMfaAt: ceremonyAt, appLinkMfaNet: 'asn:64500' }),
      );
      await POST(request({ idToken: 'firebase-id-token' }));
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, 'challenge', ceremonyAt, 'asn:64500');
    });

    it('dates a claim with no ceremony time at 0, so it never reads as fresh', async () => {
      mockVerifyIdToken.mockResolvedValue(decoded('custom', { appLinkMfa: 'challenge' }));
      await POST(request({ idToken: 'firebase-id-token' }));
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, 'challenge', 0, undefined);
    });

    it('passes a device-trust claim through as device-trust', async () => {
      mockVerifyIdToken.mockResolvedValue(decoded('custom', { appLinkMfa: 'device-trust' }));
      await POST(request({ idToken: 'firebase-id-token' }));
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, 'device-trust', 0, undefined);
    });

    it.each(['password', 'google.com'])('ignores the claim on a %s sign-in', async (provider) => {
      mockVerifyIdToken.mockResolvedValue(decoded(provider, { appLinkMfa: 'challenge' }));
      await POST(request({ idToken: 'firebase-id-token' }));
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, undefined, undefined, undefined);
    });

    it('passes nothing for a custom-token sign-in without the claim (passkey)', async () => {
      mockVerifyIdToken.mockResolvedValue(decoded('custom'));
      await POST(request({ idToken: 'firebase-id-token' }));
      expect(mockCreateSession).toHaveBeenCalledWith('user-1', 7, undefined, undefined, undefined);
    });
  });
});
