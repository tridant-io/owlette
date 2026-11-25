/**
 * the 5-minute lease, both halves.
 *
 * the browser half is where authorisation being withdrawn actually reaches the
 * operator, so what is under test is the timing (early enough that one lost
 * request costs nothing) and the difference between the api withdrawing the
 * session and anything else going wrong on the way to it.
 *
 * the revocation half is the fast path for the same decision: the lease alone
 * ends a removed member's session within five minutes, and this closes that to
 * the kill path's two seconds.
 */

import type { SwoopSession } from '@/lib/swoop/features';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const listUnendedSwoopSessionsForUser = jest.fn();
const endSwoopSession = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/lib/swoop/sessionStore.server', () => ({
  listUnendedSwoopSessionsForUser: (...a: unknown[]) => listUnendedSwoopSessionsForUser(...a),
  endSwoopSession: (...a: unknown[]) => endSwoopSession(...a),
}));

/** `sid` ended for everyone in it, naming the person it was ended for. */
const endedFor = (sid: string, uid: string) =>
  expect(endSwoopSession).toHaveBeenCalledWith(expect.objectContaining({ sid, endReason: 'revoked', endedFor: uid }));

const killSession = jest.fn(async () => ({ ok: true }));
jest.mock('@/lib/swoop/signal.server', () => ({
  killSession: (...a: unknown[]) => killSession(...a),
}));

const requestSwoopSession = jest.fn(async () => ({ commandId: 'cmd-1' }));
jest.mock('@/lib/actions/requestSwoopSession.server', () => ({
  requestSwoopSession: (...a: unknown[]) => requestSwoopSession(...a),
}));

const recordSwoopSessionEnded = jest.fn(async () => undefined);
jest.mock('@/lib/swoop/audit.server', () => ({
  recordSwoopSessionEnded: (...a: unknown[]) => recordSwoopSessionEnded(...a),
}));

import { attach, leaseFailure, SwoopLeaseRefused } from '@/lib/swoop/lease';
import { revokeSwoopSessionsForUser } from '@/lib/swoop/revokeViewerSessions.server';

const NOW = 1_700_000_000_000;
const LEASE_MS = 300_000;
/** 60 % of a full 5-minute lease. */
const RENEW_AFTER_MS = 180_000;

interface Harness {
  session: SwoopSession;
  renewLease: jest.Mock;
  presentLease: jest.Mock;
  end: jest.Mock;
}

function harness(): Harness {
  let expiresAt = NOW + LEASE_MS;
  const renewLease = jest.fn(async () => {
    expiresAt = Date.now() + LEASE_MS;
    return { viewerJwt: 'header.payload.signature', expiresAt };
  });
  const end = jest.fn();
  const presentLease = jest.fn(async () => undefined);
  const session = {
    renewLease,
    leaseExpiresAt: () => expiresAt,
    end,
    peer: { presentLease },
  } as unknown as SwoopSession;
  return { session, renewLease, presentLease, end };
}

/** run the timer callback AND let the promise it started settle. */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('lease.ts — the browser renewer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it('renews at 60% of the lease, not at its expiry', async () => {
    const { session, renewLease } = harness();
    const detach = attach(session);

    await advance(RENEW_AFTER_MS - 1);
    expect(renewLease).not.toHaveBeenCalled();
    await advance(1);
    expect(renewLease).toHaveBeenCalledTimes(1);
    detach();
  });

  it('presents every renewed token to the host, whose ledger is the one that drops a viewer', async () => {
    const { session, renewLease, presentLease } = harness();
    renewLease
      .mockImplementationOnce(async () => ({ viewerJwt: 'renewed.jwt.1', expiresAt: Date.now() + LEASE_MS }))
      .mockImplementationOnce(async () => ({ viewerJwt: 'renewed.jwt.2', expiresAt: Date.now() + LEASE_MS }));
    const detach = attach(session);

    await advance(RENEW_AFTER_MS);
    expect(presentLease).toHaveBeenCalledWith('renewed.jwt.1');
    await advance(RENEW_AFTER_MS);
    expect(presentLease.mock.calls.map((call) => call[0])).toEqual(['renewed.jwt.1', 'renewed.jwt.2']);
    detach();
  });

  it('re-arms from the expiry the server returned, so a changed leaseSeconds is followed', async () => {
    const { session, renewLease } = harness();
    // a server that halves the lease must halve the renewal interval with it.
    renewLease.mockImplementation(async () => ({
      viewerJwt: 'header.payload.signature',
      expiresAt: Date.now() + LEASE_MS / 2,
    }));
    const detach = attach(session);

    await advance(RENEW_AFTER_MS);
    expect(renewLease).toHaveBeenCalledTimes(1);
    await advance(RENEW_AFTER_MS / 2 - 1);
    expect(renewLease).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(renewLease).toHaveBeenCalledTimes(2);
    detach();
  });

  it('turns only the api’s policy or plan refusal into a SwoopLeaseRefused', () => {
    const refused = leaseFailure(403, { code: 'capability_missing', detail: 'you do not have permission to do this.' });
    expect(refused).toBeInstanceOf(SwoopLeaseRefused);
    expect(refused.message).toBe('you do not have permission to do this.');
    // the plan gate's 402: no retry changes the plan.
    expect(leaseFailure(402, { code: 'plan_required', detail: "this site's plan doesn't include swoop." })).toBeInstanceOf(
      SwoopLeaseRefused,
    );

    expect(leaseFailure(401, { code: 'unauthorized', detail: 'Unauthorized: Session expired' })).not.toBeInstanceOf(
      SwoopLeaseRefused,
    );
    expect(leaseFailure(403, {})).not.toBeInstanceOf(SwoopLeaseRefused);
    expect(leaseFailure(404, {}).message).toBe('the session lease could not be renewed.');
  });

  it('ends the session for good on a policy refusal, in the api’s own sentence', async () => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(
      leaseFailure(403, { code: 'capability_missing', detail: 'you do not have permission to do this.' }),
    );
    attach(session);

    await advance(RENEW_AFTER_MS);
    expect(end).toHaveBeenCalledWith('lease_refused', 'you do not have permission to do this.');

    // terminal: nothing is armed behind it.
    await advance(LEASE_MS * 4);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a lapsed login', 401, { code: 'unauthorized', detail: 'Unauthorized: Session expired' }],
    ['an edge in front of the app', 403, {}],
  ])('retries %s, and starts over once the host’s grace is gone', async (_what, status, problem) => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(leaseFailure(status, problem));
    attach(session);

    await advance(RENEW_AFTER_MS);
    await advance(5_000);
    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(end).not.toHaveBeenCalled();

    await advance(LEASE_MS);
    expect(end).toHaveBeenCalledWith('lease_expired', 'this session lost its lease and ended.');
  });

  it('retries a failure that is not a refusal, then gives up once the host’s grace is gone', async () => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(new Error('the session lease could not be renewed.'));
    attach(session);

    await advance(RENEW_AFTER_MS);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(end).not.toHaveBeenCalled();

    // it keeps trying every 5 s while the lease plus its 30 s grace has time left.
    await advance(5_000);
    expect(renewLease).toHaveBeenCalledTimes(2);

    // past expiry + 30 s the host has already dropped this viewer.
    await advance(LEASE_MS);
    expect(end).toHaveBeenCalledWith('lease_expired', 'this session lost its lease and ended.');
    const calls = renewLease.mock.calls.length;
    await advance(LEASE_MS);
    expect(renewLease).toHaveBeenCalledTimes(calls);
  });

  it('detaching stops the renewer', async () => {
    const { session, renewLease } = harness();
    attach(session)();
    await advance(LEASE_MS * 2);
    expect(renewLease).not.toHaveBeenCalled();
  });
});

describe('revokeSwoopSessionsForUser', () => {
  const SITE = 'site-a';
  const UID = 'user-removed';
  const ACTOR = {
    type: 'user' as const,
    userId: 'user-admin',
    role: 'admin' as const,
    siteRoles: { [SITE]: 'admin' as const },
  };

  const controlSession = {
    sid: 'sid-control',
    siteId: SITE,
    machineId: 'machine-1',
    state: 'live',
    createdBy: UID,
    startedAt: NOW - 60_000,
    viewers: [{ viewerId: 'v1', uid: UID, ctl: true, joinedAt: NOW, leaseExpiresAt: NOW }],
  };
  const watchSession = {
    ...controlSession,
    sid: 'sid-watch',
    machineId: 'machine-2',
    viewers: [{ viewerId: 'v2', uid: UID, ctl: false, joinedAt: NOW, leaseExpiresAt: NOW }],
  };

  const revoke = (extra: Record<string, unknown> = {}) =>
    revokeSwoopSessionsForUser({
      siteId: SITE,
      uid: UID,
      actor: ACTOR,
      auditActor: `user:${ACTOR.userId}`,
      reason: 'member_removed',
      ...extra,
    });

  // the agent's swoop_kill (4.0.1 and every earlier one) stops whatever streamer is
  // running, whatever sid it names, so a polled one queued beside a broadcast that
  // landed hits the next session.
  it('ends a removed member’s sessions over the room broadcast, queueing no polled kill when it lands', async () => {
    listUnendedSwoopSessionsForUser.mockResolvedValue([controlSession, watchSession]);
    killSession.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true });

    const result = await revoke();

    expect(result.revokedSids).toEqual(['sid-control', 'sid-watch']);
    endedFor('sid-control', UID);
    expect(killSession).toHaveBeenCalledWith({
      siteId: SITE,
      machineId: 'machine-1',
      sid: 'sid-control',
    });
    expect(requestSwoopSession).not.toHaveBeenCalled();
    expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-control', endReason: 'member_removed', endedFor: UID }),
    );
  });

  it('falls back to the polled kill when the broadcast throws', async () => {
    listUnendedSwoopSessionsForUser.mockResolvedValue([controlSession]);
    killSession.mockRejectedValueOnce(new Error('network down'));

    const result = await revoke();

    expect(result.revokedSids).toEqual(['sid-control']);
    expect(requestSwoopSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'swoop_kill', sid: 'sid-control' }),
    );
  });

  it('a demotion ends only the sessions the user holds control in', async () => {
    listUnendedSwoopSessionsForUser.mockResolvedValue([controlSession, watchSession]);

    const result = await revoke({ reason: 'role_changed', controlOnly: true });

    expect(result.revokedSids).toEqual(['sid-control']);
    expect(killSession).toHaveBeenCalledTimes(1);
  });

  it('a relay that is down costs the two seconds, not the revocation', async () => {
    listUnendedSwoopSessionsForUser.mockResolvedValue([controlSession]);
    killSession.mockResolvedValue({ ok: false, reason: 'unreachable' } as never);

    const result = await revoke();

    expect(result.revokedSids).toEqual(['sid-control']);
    // the record is ended regardless: the lease route refuses the next renewal.
    expect(endSwoopSession).toHaveBeenCalledTimes(1);
    endedFor('sid-control', UID);
    // and the polled command, the last resort, goes in the broadcast's place.
    expect(requestSwoopSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'swoop_kill', sid: 'sid-control' }),
    );
  });

  it('never throws at its caller when the sweep itself fails', async () => {
    listUnendedSwoopSessionsForUser.mockRejectedValue(new Error('index missing'));

    await expect(revoke()).resolves.toEqual({ revokedSids: [] });
  });

  /**
   * several viewers share a session, and the kill ends a whole sid: there is no
   * way to drop one viewer (PROTOCOL.md §10), and a seat taken out of the record
   * left a removed member watching, in control if they held it, for up to a
   * lease. so the session ends for everyone in it, and the record names whom it
   * was ended for, so everyone else starts the next one on their own.
   */
  describe('in a session someone else is still in', () => {
    const otherSeat = { viewerId: 'v-other', uid: 'user-other', ctl: true, joinedAt: NOW, leaseExpiresAt: NOW };
    const shared = { ...controlSession, viewers: [...controlSession.viewers, otherSeat] };

    it('ends it at once for everyone, stops the streamer and names whom it was ended for', async () => {
      listUnendedSwoopSessionsForUser.mockResolvedValue([shared]);

      const result = await revoke();

      expect(result.revokedSids).toEqual(['sid-control']);
      endedFor('sid-control', UID);
      expect(killSession).toHaveBeenCalledWith({ siteId: SITE, machineId: 'machine-1', sid: 'sid-control' });
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-control', endReason: 'member_removed' }),
      );
    });

    it('a demotion ends one the user holds control in, though they watch in it too', async () => {
      const watchSeat = { viewerId: 'v1-watch', uid: UID, ctl: false, joinedAt: NOW, leaseExpiresAt: NOW };
      listUnendedSwoopSessionsForUser.mockResolvedValue([{ ...shared, viewers: [...shared.viewers, watchSeat] }]);

      await revoke({ reason: 'role_changed', controlOnly: true });

      endedFor('sid-control', UID);
      expect(killSession).toHaveBeenCalledTimes(1);
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-control', endReason: 'role_changed' }),
      );
    });

    it('a demotion leaves one the user only watches in alone', async () => {
      const watchSeat = { viewerId: 'v1-watch', uid: UID, ctl: false, joinedAt: NOW, leaseExpiresAt: NOW };
      listUnendedSwoopSessionsForUser.mockResolvedValue([{ ...controlSession, viewers: [watchSeat, otherSeat] }]);

      const result = await revoke({ reason: 'role_changed', controlOnly: true });

      expect(result.revokedSids).toEqual([]);
      expect(endSwoopSession).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
    });

    // a session they started and left goes on: they are not in it to be dropped.
    it('leaves one the user started but is no longer in alone', async () => {
      listUnendedSwoopSessionsForUser.mockResolvedValue([{ ...controlSession, viewers: [otherSeat] }]);

      const result = await revoke();

      expect(result.revokedSids).toEqual([]);
      expect(endSwoopSession).not.toHaveBeenCalled();
      expect(killSession).not.toHaveBeenCalled();
    });
  });

  /**
   * a narrowed machine scope ends the sessions on the machines that left it,
   * whole, as every revocation does, and leaves the ones on machines still in it.
   */
  describe('a narrowed machine scope', () => {
    const onM1Control = { ...controlSession, sid: 'sid-m1-control', machineId: 'm1' };
    const onM1Watch = { ...watchSession, sid: 'sid-m1-watch', machineId: 'm1' };
    const onM2 = { ...watchSession, sid: 'sid-m2', machineId: 'm2' };
    const otherSeat = { viewerId: 'v-other', uid: 'user-other', ctl: true, joinedAt: NOW, leaseExpiresAt: NOW };

    it('ends their session on a machine that left it, audited scope_changed, and leaves the ones on m1', async () => {
      const leftOnM2 = { ...onM2, sid: 'sid-m2-left', viewers: [otherSeat] };
      listUnendedSwoopSessionsForUser.mockResolvedValue([onM1Control, onM1Watch, onM2, leftOnM2]);

      const result = await revoke({ reason: 'scope_changed', keepMachineIds: ['m1'] });

      expect(result.revokedSids).toEqual(['sid-m2']);
      expect(endSwoopSession).toHaveBeenCalledTimes(1);
      endedFor('sid-m2', UID);
      expect(recordSwoopSessionEnded).toHaveBeenCalledTimes(1);
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-m2', machineId: 'm2', endReason: 'scope_changed', endedFor: UID }),
      );
    });

    it('with controlOnly, also ends the one they control on m1, audited with the call’s reason', async () => {
      listUnendedSwoopSessionsForUser.mockResolvedValue([onM1Control, onM1Watch, onM2]);

      const result = await revoke({ reason: 'role_changed', controlOnly: true, keepMachineIds: ['m1'] });

      expect(result.revokedSids).toEqual(['sid-m1-control', 'sid-m2']);
      expect(recordSwoopSessionEnded).toHaveBeenCalledTimes(2);
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-m1-control', endReason: 'role_changed' }),
      );
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-m2', endReason: 'scope_changed' }),
      );
    });

    // release 1 ends the whole sid, so the others rejoin and the api decides each again
    it('ends a shared session on m2 for everyone in it, naming whom it was ended for', async () => {
      listUnendedSwoopSessionsForUser.mockResolvedValue([{ ...onM2, viewers: [...onM2.viewers, otherSeat] }]);

      const result = await revoke({ reason: 'scope_changed', keepMachineIds: ['m1'] });

      expect(result.revokedSids).toEqual(['sid-m2']);
      endedFor('sid-m2', UID);
      expect(killSession).toHaveBeenCalledWith({ siteId: SITE, machineId: 'm2', sid: 'sid-m2' });
      expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 'sid-m2', endReason: 'scope_changed', endedFor: UID }),
      );
    });

    it('ends one on m2 they are alone in', async () => {
      listUnendedSwoopSessionsForUser.mockResolvedValue([onM2]);

      const result = await revoke({ reason: 'scope_changed', keepMachineIds: ['m1'] });

      expect(result.revokedSids).toEqual(['sid-m2']);
      endedFor('sid-m2', UID);
      expect(killSession).toHaveBeenCalledWith({ siteId: SITE, machineId: 'm2', sid: 'sid-m2' });
    });
  });
});
