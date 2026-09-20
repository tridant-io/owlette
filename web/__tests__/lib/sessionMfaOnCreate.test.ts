/** @jest-environment node */

/**
 * `resolveMfaOnSessionCreate` — the pure session-create MFA decision.
 *
 * Extracted from `createSession` precisely because that can't be unit-tested:
 * the repo has no iron-session mock. The helper holds every branch (fresh
 * mfaRequired, the preserve rule, the passkey-uv and device-trust birth paths)
 * with zero I/O, so plain objects suffice.
 *
 * firebase-admin is stubbed only to keep the transitive import hermetic; the
 * pure helper never touches it.
 */

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
}));

import {
  resolveMfaOnSessionCreate,
  sessionPassedMfaCeremony,
  type MfaSatisfiedBy,
} from '@/lib/sessionManager.server';

const NOW = 1_700_000_000_000;
const USER = 'user-1';
const PREV_COMPLETED_AT = NOW - 5_000;

/** A prior session that satisfies the preserve rule: real challenge, live. */
function preservablePrev(
  overrides: Record<string, unknown> = {}
): {
  userId?: string;
  expiresAt?: number;
  mfaRequired?: boolean;
  mfaVerified?: boolean;
  mfaCompletedAt?: number;
  mfaSatisfiedBy?: MfaSatisfiedBy;
} {
  return {
    userId: USER,
    expiresAt: NOW + 60_000, // unexpired
    mfaRequired: true,
    mfaVerified: true,
    mfaCompletedAt: PREV_COMPLETED_AT,
    mfaSatisfiedBy: 'challenge',
    ...overrides,
  };
}

const REQUIRED = { mfaRequired: true, mfaVerified: false };
const NOT_REQUIRED = { mfaRequired: false, mfaVerified: true };

describe('resolveMfaOnSessionCreate', () => {
  describe('preserve branch (required + prior verified challenge)', () => {
    it('preserves verified state and carries mfaCompletedAt from prev', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: PREV_COMPLETED_AT,
        mfaSatisfiedBy: 'challenge',
      });
    });

    /**
     * AuthContext re-POSTs /api/auth/session on every load, so this branch runs
     * constantly. It must carry the satisfier verbatim: a device-trust birth
     * that laundered itself into `challenge` on the next page load would hand
     * swoop's step-up window to a cookie that ran no ceremony.
     */
    it('carries prev.mfaSatisfiedBy verbatim rather than upgrading it', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev({ mfaSatisfiedBy: 'device-trust' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out.mfaSatisfiedBy).toBe('device-trust');
      expect(sessionPassedMfaCeremony(out)).toBe(false);
    });

    it('takes precedence over device trust (completion time from prev, not now)', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true, // both preserve AND trust would apply
      });
      expect(out.mfaVerified).toBe(true);
      expect(out.mfaCompletedAt).toBe(PREV_COMPLETED_AT);
      expect(out.mfaCompletedAt).not.toBe(NOW);
    });
  });

  describe('preserve rejected — each condition violated independently', () => {
    // Required + untrusted: a rejected preserve must fall through to the
    // challenge — verified:false, no completion timestamp.
    const expectChallenge = (prev: ReturnType<typeof preservablePrev>) => {
      const out = resolveMfaOnSessionCreate({
        prev,
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    };

    it('rejects a different uid', () => {
      expectChallenge(preservablePrev({ userId: 'someone-else' }));
    });

    it('rejects an expired prior session (expiresAt <= now)', () => {
      expectChallenge(preservablePrev({ expiresAt: NOW })); // boundary: not > now
      expectChallenge(preservablePrev({ expiresAt: NOW - 1 }));
    });

    it('rejects a missing / non-number expiresAt', () => {
      expectChallenge(preservablePrev({ expiresAt: undefined }));
      expectChallenge(
        preservablePrev({ expiresAt: 'nope' as unknown as number })
      );
    });

    it('rejects prev.mfaRequired === false (the post-disable case)', () => {
      // Post-disable sessions are mfaRequired=false + mfaVerified=true, and
      // must NOT preserve into a newly-required session.
      expectChallenge(preservablePrev({ mfaRequired: false }));
    });

    it('rejects prev.mfaVerified === false', () => {
      expectChallenge(preservablePrev({ mfaVerified: false }));
    });
  });

  describe('device-trust birth path (required, preserve inapplicable)', () => {
    it('births verified with mfaCompletedAt = now when the device is trusted', () => {
      const out = resolveMfaOnSessionCreate({
        // Different uid, so preserve can't apply and trust is reached.
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
        mfaSatisfiedBy: 'device-trust',
      });
    });

    /**
     * The whole point of recording the satisfier: this session is verified and
     * carries a completion time of `now`, and nothing was proved to get it.
     */
    it('is not a ceremony, however fresh its mfaCompletedAt looks', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
      });
      expect(out.mfaCompletedAt).toBe(NOW);
      expect(sessionPassedMfaCeremony(out)).toBe(false);
    });
  });

  describe('required, no preserve, untrusted → challenge', () => {
    it('is unverified with no completion timestamp', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {}, // empty prior session — nothing to preserve
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    });
  });

  describe('not-required branch (resolved.mfaRequired === false)', () => {
    it('is verified with NO completion timestamp, regardless of prev/trust', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(), // would preserve if it mattered
        resolved: NOT_REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true, // would trust if it mattered
      });
      expect(out).toEqual({ mfaRequired: false, mfaVerified: true });
      expect(out.mfaCompletedAt).toBeUndefined();
    });
  });

  // A user-verified passkey ceremony satisfies MFA in one step. These pin both
  // halves: the birth path works, and every existing path is unchanged.
  describe('mfaSatisfiedBy: passkey-uv', () => {
    it('births a required session verified with mfaCompletedAt = now', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {}, // nothing to preserve; the passkey input does the work
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
        mfaSatisfiedBy: 'passkey-uv',
      });
      // One UV ceremony is a live proof of credential and human alike.
      expect(sessionPassedMfaCeremony(out)).toBe(true);
    });

    it('is the only difference: the same input without it still challenges', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {},
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
      });
      expect(out).toEqual({ mfaRequired: true, mfaVerified: false });
      expect(out.mfaCompletedAt).toBeUndefined();
    });

    it('never flips mfaRequired — a not-required account resolves unchanged', () => {
      const out = resolveMfaOnSessionCreate({
        prev: {},
        resolved: NOT_REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      // The not-required branch short-circuits before passkey-uv is consulted.
      expect(out).toEqual({ mfaRequired: false, mfaVerified: true });
      expect(out.mfaCompletedAt).toBeUndefined();
    });

    it('does not disturb the preserve path (prev completion time still wins)', () => {
      const out = resolveMfaOnSessionCreate({
        prev: preservablePrev(),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: false,
        mfaSatisfiedBy: 'passkey-uv',
      });
      expect(out).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: PREV_COMPLETED_AT,
        mfaSatisfiedBy: 'challenge',
      });
      expect(out.mfaCompletedAt).not.toBe(NOW);
    });

    it('outranks device trust, and is recorded as the ceremony it is', () => {
      // Different uid, so preserve can't apply and the birth paths are reached.
      const both = resolveMfaOnSessionCreate({
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
        mfaSatisfiedBy: 'passkey-uv',
      });
      const trustOnly = resolveMfaOnSessionCreate({
        prev: preservablePrev({ userId: 'someone-else' }),
        resolved: REQUIRED,
        userId: USER,
        now: NOW,
        deviceTrusted: true,
      });
      // Verified either way, and at the same moment; the satisfier is the whole
      // difference, and it is the one that names a live ceremony.
      expect(both).toEqual({
        mfaRequired: true,
        mfaVerified: true,
        mfaCompletedAt: NOW,
        mfaSatisfiedBy: 'passkey-uv',
      });
      expect(trustOnly).toEqual({ ...both, mfaSatisfiedBy: 'device-trust' });
      expect(sessionPassedMfaCeremony(both)).toBe(true);
      expect(sessionPassedMfaCeremony(trustOnly)).toBe(false);
    });
  });
});
