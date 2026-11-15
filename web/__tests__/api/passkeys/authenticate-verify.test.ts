/** @jest-environment node */

const mockGetAndDeleteChallenge = jest.fn();
const mockGetUserPasskeys = jest.fn();
const mockVerifyAuthenticationResponse = jest.fn();

jest.mock('@/lib/withRateLimit', () => ({
  withRateLimit: (h: unknown) => h,
}));

jest.mock('@/lib/authEvents.server');

jest.mock('@/lib/apiAuth.server', () => {
  class ApiAuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { ApiAuthError, assertActiveUser: async () => undefined };
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => ({ createCustomToken: async () => 'custom-token' }),
}));

jest.mock('@/lib/sessionManager.server', () => ({
  createSession: jest.fn(),
}));

jest.mock('@/lib/swoop/networks.server', () => ({
  signInCeremonyNetwork: async () => 'unknown',
}));

jest.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: (...a: unknown[]) => mockVerifyAuthenticationResponse(...a),
}));

jest.mock('@/lib/webauthn.server', () => ({
  getRpId: () => 'owlette.app',
  getExpectedOrigins: () => ['https://owlette.app'],
  getAndDeleteChallenge: (...a: unknown[]) => mockGetAndDeleteChallenge(...a),
  getUserPasskeys: (...a: unknown[]) => mockGetUserPasskeys(...a),
  updatePasskeyCounter: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { POST } from '@/app/api/passkeys/authenticate/verify/route';
import { recordAuthFailure } from '@/lib/authEvents.server';

function request(credentialId = 'cred-1'): NextRequest {
  return new NextRequest('http://localhost/api/passkeys/authenticate/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: { id: credentialId, response: { userHandle: isoBase64URL.fromUTF8String('uid-1') } },
      challengeId: 'challenge-1',
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAndDeleteChallenge.mockResolvedValue({ type: 'authentication', challenge: 'c' });
  mockGetUserPasskeys.mockResolvedValue([
    { credentialId: 'cred-1', credentialPublicKey: isoBase64URL.fromBuffer(new Uint8Array([1])), counter: 0 },
  ]);
});

describe('POST /api/passkeys/authenticate/verify', () => {
  it('records an assertion that did not verify, for a passkey the user owns', async () => {
    mockVerifyAuthenticationResponse.mockResolvedValue({ verified: false });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(recordAuthFailure).toHaveBeenCalledWith(expect.anything(), {
      userId: 'uid-1',
      capability: 'AUTH_SIGN_IN',
      event: 'sign_in_failed',
      reason: 'passkey_assertion_failed',
      method: 'passkey',
    });
  });

  it('records nothing when the passkey is not found, where the uid is only a claim', async () => {
    const res = await POST(request('someone-elses-credential'));

    expect(res.status).toBe(400);
    expect(recordAuthFailure).not.toHaveBeenCalled();
  });
});
