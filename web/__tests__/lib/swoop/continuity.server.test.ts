/**
 * continuity: a control session's step-up carried to the next mint from the
 * same tab. what is under test is the one-shot, same-user, same-session
 * contract and the ends that close it for good.
 */

import {
  continuityHash,
  continuityInherits,
  mintContinuity,
  parseContinuity,
} from '@/lib/swoop/continuity.server';

import type { SwoopSession } from '@/lib/swoop/sessionStore.server';

function record(overrides: Partial<SwoopSession> = {}): SwoopSession {
  return {
    sid: 'sid-1',
    siteId: 'site',
    machineId: 'TEC-B4A',
    state: 'ended',
    createdBy: 'user:alice',
    startedAt: 1,
    absoluteExpiresAt: 2,
    viewers: [{ viewerId: 'v1', uid: 'alice', ctl: true, joinedAt: 1, leaseExpiresAt: 2 }],
    endReason: 'lease_expired',
    ...overrides,
  };
}

describe('swoop continuity', () => {
  it('mints a token the record can verify without holding the secret', () => {
    const minted = mintContinuity('sid-1');
    const parsed = parseContinuity(minted.token);
    expect(parsed).toEqual({ sid: 'sid-1', hash: minted.hash });
    expect(minted.token).not.toContain(minted.hash);
    expect(minted.hash).toHaveLength(64);
  });

  it('refuses anything that is not `<sid>.<43 url-safe chars>`', () => {
    expect(parseContinuity(undefined)).toBeNull();
    expect(parseContinuity('sid-1')).toBeNull();
    expect(parseContinuity('sid-1.short')).toBeNull();
    expect(parseContinuity(`sid-1.${'a'.repeat(43)}=`)).toBeNull();
  });

  it('inherits for the same user on a control session that ended for a transient reason', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    for (const endReason of ['lease_expired', 'signal_lost', 'host_exit', 'error', undefined] as const) {
      expect(
        continuityInherits({ record: record({ continuityHash: minted.hash, endReason }), userId: 'alice', hash }),
      ).toEqual({ ok: true });
    }
  });

  it('never inherits past a kill, a deliberate close or a revocation', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    for (const endReason of ['closed', 'killed', 'revoked'] as const) {
      expect(
        continuityInherits({ record: record({ continuityHash: minted.hash, endReason }), userId: 'alice', hash }),
      ).toEqual({ ok: false, reason: 'ended_for_good' });
    }
  });

  it('is one-shot, bound to the user and to a control session, and needs the secret', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const good = record({ continuityHash: minted.hash });
    expect(continuityInherits({ record: null, userId: 'alice', hash })).toEqual({ ok: false, reason: 'no_session' });
    expect(continuityInherits({ record: good, userId: 'bob', hash })).toEqual({ ok: false, reason: 'not_yours' });
    expect(
      continuityInherits({
        record: record({ continuityHash: minted.hash, viewers: [{ ...good.viewers[0], ctl: false }] }),
        userId: 'alice',
        hash,
      }),
    ).toEqual({ ok: false, reason: 'not_control' });
    expect(continuityInherits({ record: good, userId: 'alice', hash: continuityHash('other') })).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
    expect(continuityInherits({ record: record({}), userId: 'alice', hash })).toEqual({
      ok: false,
      reason: 'secret_mismatch',
    });
    expect(
      continuityInherits({ record: record({ continuityHash: minted.hash, continuityUsedAt: 5 }), userId: 'alice', hash }),
    ).toEqual({ ok: false, reason: 'spent' });
  });
});
