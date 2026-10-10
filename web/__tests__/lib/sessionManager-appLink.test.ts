/** @jest-environment node */

/**
 * `resolveMfaOnSessionCreate` with the satisfiers an app-link sign-in passes (the approver's
 * `mfaSatisfiedBy`, read off the custom token's `appLinkMfa` claim). `challenge` births verified
 * like a fresh ceremony; `device-trust` takes the device-trust branch and stays not-a-ceremony.
 */

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

import {
  resolveMfaOnSessionCreate,
  sessionPassedMfaCeremony,
} from '@/lib/sessionManager.server';

const NOW = 1_700_000_000_000;
const USER = 'user-1';
const REQUIRED = { mfaRequired: true, mfaVerified: false };
const NOT_REQUIRED = { mfaRequired: false, mfaVerified: true };

describe('resolveMfaOnSessionCreate — app-link satisfiers', () => {
  it('challenge births a required session verified now, as the ceremony it carries', () => {
    const out = resolveMfaOnSessionCreate({
      prev: {},
      resolved: REQUIRED,
      userId: USER,
      now: NOW,
      deviceTrusted: false,
      mfaSatisfiedBy: 'challenge',
    });
    expect(out).toEqual({
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: NOW,
      mfaSatisfiedBy: 'challenge',
    });
    expect(sessionPassedMfaCeremony(out)).toBe(true);
  });

  // swoop counts a sign-in ceremony under five minutes old as its step-up, so the
  // app's session carries the approver's ceremony time, never the hand-off's.
  it('challenge carries the approver ceremony time when the claim names one', () => {
    const out = resolveMfaOnSessionCreate({
      prev: {},
      resolved: REQUIRED,
      userId: USER,
      now: NOW,
      deviceTrusted: false,
      mfaSatisfiedBy: 'challenge',
      mfaSatisfiedAt: NOW - 3 * 24 * 60 * 60 * 1000,
    });
    expect(out).toEqual({
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: NOW - 3 * 24 * 60 * 60 * 1000,
      mfaSatisfiedBy: 'challenge',
    });
  });

  it('device-trust takes the device-trust branch and is not a ceremony', () => {
    const out = resolveMfaOnSessionCreate({
      prev: {},
      resolved: REQUIRED,
      userId: USER,
      now: NOW,
      deviceTrusted: false,
      mfaSatisfiedBy: 'device-trust',
    });
    expect(out).toEqual({
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: NOW,
      mfaSatisfiedBy: 'device-trust',
    });
    expect(sessionPassedMfaCeremony(out)).toBe(false);
  });

  it('never flips mfaRequired for an account without mfa', () => {
    for (const mfaSatisfiedBy of ['challenge', 'device-trust'] as const) {
      expect(
        resolveMfaOnSessionCreate({
          prev: {},
          resolved: NOT_REQUIRED,
          userId: USER,
          now: NOW,
          deviceTrusted: false,
          mfaSatisfiedBy,
        }),
      ).toEqual({ mfaRequired: false, mfaVerified: true });
    }
  });

  it('leaves a live prior session for the same user as it was', () => {
    const out = resolveMfaOnSessionCreate({
      prev: {
        userId: USER,
        expiresAt: NOW + 60_000,
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW - 5_000,
        mfaSatisfiedBy: 'device-trust',
      },
      resolved: REQUIRED,
      userId: USER,
      now: NOW,
      deviceTrusted: false,
      mfaSatisfiedBy: 'challenge',
    });
    expect(out).toEqual({
      mfaRequired: true,
      mfaVerified: true,
      mfaCompletedAt: NOW - 5_000,
      mfaSatisfiedBy: 'device-trust',
    });
  });

  it('without a satisfier the same input still challenges', () => {
    expect(
      resolveMfaOnSessionCreate({
        prev: {},
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      }),
    ).toEqual({ mfaRequired: true, mfaVerified: false });
  });
});
