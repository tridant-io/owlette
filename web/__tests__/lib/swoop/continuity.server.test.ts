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

/** an ended record as the store writes it: `endSwoopSession` empties `viewers`. */
function record(overrides: Partial<SwoopSession> = {}): SwoopSession {
  return {
    sid: 'sid-1',
    siteId: 'site',
    machineId: 'TEC-B4A',
    state: 'ended',
    createdBy: 'user:alice',
    startedAt: 1,
    viewers: [],
    endReason: 'lease_expired',
    ...overrides,
  };
}

/** alice's verdict, on a machine no kill has touched unless `revokedAt` says otherwise. */
function verdict(rec: SwoopSession | null, hash: string, over: { userId?: string; revokedAt?: number } = {}) {
  return continuityInherits({ record: rec, userId: over.userId ?? 'alice', hash, revokedAt: over.revokedAt ?? 0 });
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
      expect(verdict(record({ continuityHash: minted.hash, endReason }), hash)).toEqual({ ok: true });
    }
  });

  it('never inherits past a kill, a deliberate close or a revocation', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    for (const endReason of ['closed', 'killed', 'revoked'] as const) {
      expect(verdict(record({ continuityHash: minted.hash, endReason }), hash)).toEqual({
        ok: false,
        reason: 'ended_for_good',
      });
    }
  });

  // a kill closes only the records still open, and a tab's last one may already
  // have ended for a transient reason: the kill's own timestamp is what reaches it.
  it('never inherits from a session a kill on the machine came after', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const lapsed = record({ continuityHash: minted.hash, startedAt: 1_000, endReason: 'lease_expired' });
    expect(verdict(lapsed, hash, { revokedAt: 1_500 })).toEqual({ ok: false, reason: 'killed' });
    expect(verdict(lapsed, hash, { revokedAt: 1_000 })).toEqual({ ok: false, reason: 'killed' });
  });

  it('inherits from a session that started after the last kill', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const later = record({ continuityHash: minted.hash, startedAt: 1_000, endReason: 'lease_expired' });
    expect(verdict(later, hash, { revokedAt: 999 })).toEqual({ ok: true });
  });

  it('is one-shot, bound to the user and to a control session, and needs the secret', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const good = record({ continuityHash: minted.hash });
    expect(verdict(null, hash)).toEqual({ ok: false, reason: 'no_session' });
    expect(verdict(good, hash, { userId: 'bob' })).toEqual({ ok: false, reason: 'not_yours' });
    expect(verdict(good, continuityHash('other'))).toEqual({ ok: false, reason: 'secret_mismatch' });
    // a watch grant stores no hash at all, so no token can ever carry one into control.
    expect(verdict(record({}), hash)).toEqual({ ok: false, reason: 'secret_mismatch' });
    expect(verdict(record({ continuityHash: minted.hash, continuityUsedAt: 5 }), hash)).toEqual({
      ok: false,
      reason: 'spent',
    });
  });
});
