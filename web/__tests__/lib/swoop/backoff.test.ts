import { backoffDelayMs, isTransientEnd, type SwoopEndReason } from '@/lib/swoop/backoff';

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
