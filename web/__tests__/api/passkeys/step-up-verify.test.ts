/** @jest-environment node */

const mockVerifyAssertion = jest.fn();
const mockMarkSessionMfaVerified = jest.fn();

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
  return {
    ApiAuthError,
    requirePreMfaSession: async () => 'uid-1',
    assertActiveUser: async () => undefined,
  };
});

jest.mock('@/lib/sessionManager.server', () => ({
  markSessionMfaVerified: (...a: unknown[]) => mockMarkSessionMfaVerified(...a),
}));

jest.mock('@/lib/swoop/networks.server', () => ({
  signInCeremonyNetwork: async () => 'unknown',
}));

jest.mock('@/lib/mfaProof.server', () => ({
  verifyPasskeyStepUpAssertion: (...a: unknown[]) => mockVerifyAssertion(...a),
  mfaProofErrorResponse: (r: { status: number; error: string; code: string }) =>
    Response.json({ error: r.error, code: r.code }, { status: r.status }),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/passkeys/step-up/verify/route';
import { recordAuthFailure, recordSecondFactorPassed } from '@/lib/authEvents.server';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/passkeys/step-up/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: { id: 'cred' }, challengeId: 'challenge-1' }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/passkeys/step-up/verify', () => {
  it('records a rejected proof as a failed second factor, by the proof code', async () => {
    mockVerifyAssertion.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'passkey verification failed',
      code: 'passkey_verification_failed',
    });

    const res = await POST(request());

    expect(res.status).toBe(400);
    expect(recordSecondFactorPassed).not.toHaveBeenCalled();
    expect(recordAuthFailure).toHaveBeenCalledWith(expect.anything(), {
      userId: 'uid-1',
      capability: 'AUTH_SECOND_FACTOR',
      event: 'second_factor_failed',
      reason: 'passkey_verification_failed',
      method: 'passkey',
    });
    expect(mockMarkSessionMfaVerified).not.toHaveBeenCalled();
  });

  it('records the passed second factor, and no failure, when the proof holds', async () => {
    mockVerifyAssertion.mockResolvedValue({ ok: true, factorUsed: 'passkey' });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(recordAuthFailure).not.toHaveBeenCalled();
    expect(recordSecondFactorPassed).toHaveBeenCalledWith(expect.anything(), { userId: 'uid-1', method: 'passkey' });
  });
});
