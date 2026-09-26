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
const endSwoopSession = jest.fn(async () => undefined);
jest.mock('@/lib/swoop/sessionStore.server', () => ({
  listUnendedSwoopSessionsForUser: (...a: unknown[]) => listUnendedSwoopSessionsForUser(...a),
  endSwoopSession: (...a: unknown[]) => endSwoopSession(...a),
}));

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

  it('turns only the api’s policy refusal into a SwoopLeaseRefused', () => {
    const refused = leaseFailure(403, { code: 'capability_missing', detail: 'you do not have permission to do this.' });
    expect(refused).toBeInstanceOf(SwoopLeaseRefused);
    expect(refused.message).toBe('you do not have permission to do this.');

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
    expect(endSwoopSession).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-control', endReason: 'revoked' }),
    );
    expect(killSession).toHaveBeenCalledWith({
      siteId: SITE,
      machineId: 'machine-1',
      sid: 'sid-control',
    });
    expect(requestSwoopSession).not.toHaveBeenCalled();
    expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-control', endReason: 'member_removed' }),
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
    // and the polled command, the last resort, goes in the broadcast's place.
    expect(requestSwoopSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'swoop_kill', sid: 'sid-control' }),
    );
  });

  it('never throws at its caller when the sweep itself fails', async () => {
    listUnendedSwoopSessionsForUser.mockRejectedValue(new Error('index missing'));

    await expect(revoke()).resolves.toEqual({ revokedSids: [] });
  });
});
