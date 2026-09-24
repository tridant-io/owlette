/**
 * the 5-minute lease, both halves.
 *
 * the browser half is where authorisation being withdrawn actually reaches the
 * operator, so what is under test is the timing (early enough that one lost
 * request costs nothing), the difference between a refusal and a dropped
 * packet, and the 12-hour cap arriving as a refusal like any other.
 *
 * the revocation half is the fast path for the same decision: the lease alone
 * ends a removed member's session within five minutes, and this closes that to
 * the kill path's two seconds.
 */

import type { SwoopSession } from '@/lib/swoop/features';

const toastError = jest.fn();
jest.mock('@/lib/toast', () => ({ toast: { error: (m: unknown) => toastError(m) } }));

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

import { attach, SwoopLeaseRefused } from '@/lib/swoop/lease';
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
    toastError.mockClear();
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

  it('tears the session down on a 403 and says so once', async () => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(
      new SwoopLeaseRefused(403, 'you do not have permission to do this.'),
    );
    attach(session);

    await advance(RENEW_AFTER_MS);
    expect(end).toHaveBeenCalledWith('lease_expired');
    expect(toastError).toHaveBeenCalledWith('you do not have permission to do this.');

    // terminal: nothing is armed behind it.
    await advance(LEASE_MS * 4);
    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('treats a 401 the same way', async () => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(new SwoopLeaseRefused(401, 'this session is no longer authorised.'));
    attach(session);

    await advance(RENEW_AFTER_MS);
    expect(end).toHaveBeenCalledWith('lease_expired');
  });

  it('hard-stops at the 12 hour cap, in the api’s own words', async () => {
    const { session, renewLease, end } = harness();
    renewLease.mockRejectedValue(
      new SwoopLeaseRefused(403, 'this session reached its 12 hour limit.'),
    );
    attach(session);

    await advance(RENEW_AFTER_MS);
    expect(toastError).toHaveBeenCalledWith('this session reached its 12 hour limit.');
    expect(end).toHaveBeenCalledWith('lease_expired');
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
    expect(end).toHaveBeenCalledWith('lease_expired');
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
    absoluteExpiresAt: NOW + 1_000,
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

  it('ends a removed member’s sessions over both stop paths', async () => {
    listUnendedSwoopSessionsForUser.mockResolvedValue([controlSession, watchSession]);

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
    expect(requestSwoopSession).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'swoop_kill', sid: 'sid-control' }),
    );
    expect(recordSwoopSessionEnded).toHaveBeenCalledWith(
      expect.objectContaining({ sid: 'sid-control', endReason: 'member_removed' }),
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
  });

  it('never throws at its caller when the sweep itself fails', async () => {
    listUnendedSwoopSessionsForUser.mockRejectedValue(new Error('index missing'));

    await expect(revoke()).resolves.toEqual({ revokedSids: [] });
  });
});
