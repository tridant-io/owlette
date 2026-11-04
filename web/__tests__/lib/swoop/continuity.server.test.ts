/**
 * continuity: a control viewer's step-up carried to the next mint from the
 * same tab. what is under test is the one-shot, same-user, same-viewer
 * contract and the ends that close it for good. several viewers share one
 * session, so a grant is a viewer's, never the session's.
 */

import {
  continuityHash,
  continuityInherits,
  mintContinuity,
  parseContinuity,
} from '@/lib/swoop/continuity.server';

import type { SwoopSession } from '@/lib/swoop/sessionStore.server';

/** an ended record as the store writes it: `endSwoopSession` empties `viewers`, and the grants stay. */
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

/** alice's grant for her viewer `v-alice`, as a control mint stores it. */
function alicesGrant(hash: string, usedAt?: number): SwoopSession['continuity'] {
  return { 'v-alice': { uid: 'alice', hash, ...(usedAt !== undefined ? { usedAt } : {}) } };
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

  it('inherits for the same user on a control grant whose session ended for a transient reason, or goes on', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    for (const endReason of ['lease_expired', 'signal_lost', 'host_exit', 'error', undefined] as const) {
      expect(verdict(record({ continuity: alicesGrant(minted.hash), endReason }), hash)).toEqual({
        ok: true,
        viewerId: 'v-alice',
      });
    }
  });

  it('never inherits past a kill, a deliberate close or a revocation', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    for (const endReason of ['closed', 'killed', 'revoked'] as const) {
      expect(verdict(record({ continuity: alicesGrant(minted.hash), endReason }), hash)).toEqual({
        ok: false,
        reason: 'ended_for_good',
      });
    }
  });

  // removing one person ends the session for everyone in it, because one
  // streamer serves them all: everyone else comes back with their control.
  it('a revocation is final only for the person it was ended for', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const revoked = (endedFor?: string) =>
      record({ continuity: alicesGrant(minted.hash), endReason: 'revoked', ...(endedFor ? { endedFor } : {}) });

    expect(verdict(revoked('bob'), hash)).toEqual({ ok: true, viewerId: 'v-alice' });
    expect(verdict(revoked('alice'), hash)).toEqual({ ok: false, reason: 'ended_for_good' });
    // a record that names nobody ended for everyone
    expect(verdict(revoked(), hash)).toEqual({ ok: false, reason: 'ended_for_good' });
  });

  // a kill closes only the records still open, and a tab's last one may already
  // have ended for a transient reason: the kill's own timestamp is what reaches it.
  it('never inherits from a session a kill on the machine came after', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const lapsed = record({ continuity: alicesGrant(minted.hash), startedAt: 1_000, endReason: 'lease_expired' });
    expect(verdict(lapsed, hash, { revokedAt: 1_500 })).toEqual({ ok: false, reason: 'killed' });
    expect(verdict(lapsed, hash, { revokedAt: 1_000 })).toEqual({ ok: false, reason: 'killed' });
  });

  it('inherits from a session that started after the last kill', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const later = record({ continuity: alicesGrant(minted.hash), startedAt: 1_000, endReason: 'lease_expired' });
    expect(verdict(later, hash, { revokedAt: 999 })).toEqual({ ok: true, viewerId: 'v-alice' });
  });

  it('is one-shot, bound to the user and to a control grant, and needs the secret', () => {
    const minted = mintContinuity('sid-1');
    const { hash } = parseContinuity(minted.token)!;
    const good = record({ continuity: alicesGrant(minted.hash) });
    expect(verdict(null, hash)).toEqual({ ok: false, reason: 'no_session' });
    expect(verdict(good, hash, { userId: 'bob' })).toEqual({ ok: false, reason: 'not_yours' });
    expect(verdict(good, continuityHash('other'))).toEqual({ ok: false, reason: 'secret_mismatch' });
    // a watch grant stores no hash at all, so no token can ever carry one into control.
    expect(verdict(record({}), hash)).toEqual({ ok: false, reason: 'secret_mismatch' });
    expect(verdict(record({ continuity: alicesGrant(minted.hash, 5) }), hash)).toEqual({
      ok: false,
      reason: 'spent',
    });
  });

  // the owner's bug made this possible: two people in one session, each with a
  // control grant on the same sid.
  it('keeps two viewers of one session apart: neither inherits the other’s, and spending one spends no other', () => {
    const alice = mintContinuity('sid-1');
    const bob = mintContinuity('sid-1');
    const shared = record({
      state: 'live',
      endReason: undefined,
      continuity: {
        'v-alice': { uid: 'alice', hash: alice.hash, usedAt: 5 },
        'v-bob': { uid: 'bob', hash: bob.hash },
      },
    });
    const aliceHash = parseContinuity(alice.token)!.hash;
    const bobHash = parseContinuity(bob.token)!.hash;

    expect(verdict(shared, bobHash)).toEqual({ ok: false, reason: 'not_yours' });
    expect(verdict(shared, aliceHash, { userId: 'bob' })).toEqual({ ok: false, reason: 'not_yours' });
    expect(verdict(shared, aliceHash)).toEqual({ ok: false, reason: 'spent' });
    expect(verdict(shared, bobHash, { userId: 'bob' })).toEqual({ ok: true, viewerId: 'v-bob' });
  });
});
