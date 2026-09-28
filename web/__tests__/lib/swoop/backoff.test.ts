import {
  backoffDelayMs,
  isSwoopEndReason,
  isTransientEnd,
  isWithdrawal,
  type SwoopEndReason,
} from '@/lib/swoop/backoff';

describe('backoffDelayMs', () => {
  const ladder = { baseMs: 1000, capMs: 15000 };

  it('is immediate before the first attempt', () => {
    expect(backoffDelayMs(0, ladder)).toBe(0);
  });

  it('doubles per attempt up to the cap, with full jitter in the upper half of the rung', () => {
    expect(backoffDelayMs(1, ladder, () => 1)).toBe(1000);
    expect(backoffDelayMs(2, ladder, () => 1)).toBe(2000);
    expect(backoffDelayMs(3, ladder, () => 0)).toBe(2000);
    expect(backoffDelayMs(5, ladder, () => 1)).toBe(15000);
    expect(backoffDelayMs(50, ladder, () => 0.5)).toBe(11250);
  });
});

describe('isTransientEnd', () => {
  const table: Array<[SwoopEndReason, boolean]> = [
    ['closed', false],
    ['unmounted', false],
    ['kill', false],
    ['lease_refused', false],
    ['refused', false],
    ['lease_expired', true],
    ['host_gone', true],
    ['signal_lost', true],
    ['peer_failed', true],
    ['start_failed', true],
  ];

  it.each(table)('%s → retry %s', (reason, transient) => {
    expect(isTransientEnd(reason)).toBe(transient);
  });
});

describe('isWithdrawal', () => {
  const table: Array<[number, string | null, boolean]> = [
    [403, 'swoop_disabled', true],
    [403, 'machine_excluded', true],
    [403, 'capability_missing', true],
    [403, 'members_may_not_watch', true],
    [403, 'api_key_not_permitted', true],
    // an edge in front of the app refuses with no problem code of the api's.
    [403, null, false],
    [403, 'forbidden', false],
    [401, 'unauthorized', false],
    [404, 'not_found', false],
    [409, 'machine_offline', false],
    [429, 'rate_limited', false],
    [503, 'audit_unavailable', false],
  ];

  it.each(table)('%i %s → final %s', (status, code, final) => {
    expect(isWithdrawal(status, code)).toBe(final);
  });
});

describe('isSwoopEndReason', () => {
  it('accepts every reason the page reports and nothing else', () => {
    expect(isSwoopEndReason('peer_failed')).toBe(true);
    expect(isSwoopEndReason('closed')).toBe(true);
    expect(isSwoopEndReason('lease_expired')).toBe(true);
    expect(isSwoopEndReason('host_exit')).toBe(false);
    expect(isSwoopEndReason('')).toBe(false);
    expect(isSwoopEndReason(null)).toBe(false);
  });
});
