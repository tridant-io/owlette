/** @jest-environment node */

/**
 * Tests for zonedTimeToUtcMs — the helper that fixes the clear-logs timezone
 * bug (P2): clear bounds must be computed in the site/display timezone, not the
 * browser's. These assertions are independent of the test runner's local TZ,
 * which is the whole point of the helper.
 */

import { formatHeartbeatTime, zonedTimeToUtcMs } from '@/lib/timeUtils';

describe('zonedTimeToUtcMs', () => {
  it('treats UTC components as UTC', () => {
    expect(zonedTimeToUtcMs(2026, 4, 25, 0, 0, 0, 0, 'UTC')).toBe(
      Date.UTC(2026, 4, 25, 0, 0, 0, 0),
    );
  });

  it('resolves start-of-day in EST (winter, UTC-5)', () => {
    // Jan 15 2026 is before US DST → midnight New York = 05:00 UTC.
    expect(zonedTimeToUtcMs(2026, 0, 15, 0, 0, 0, 0, 'America/New_York')).toBe(
      Date.UTC(2026, 0, 15, 5, 0, 0, 0),
    );
  });

  it('resolves start-of-day in EDT (summer, UTC-4)', () => {
    // May 25 2026 is during US DST → midnight New York = 04:00 UTC.
    expect(zonedTimeToUtcMs(2026, 4, 25, 0, 0, 0, 0, 'America/New_York')).toBe(
      Date.UTC(2026, 4, 25, 4, 0, 0, 0),
    );
  });

  it('resolves end-of-day across the UTC date line (EDT)', () => {
    // May 25 23:59:59.999 New York (EDT) = May 26 03:59:59.999 UTC.
    expect(zonedTimeToUtcMs(2026, 4, 25, 23, 59, 59, 999, 'America/New_York')).toBe(
      Date.UTC(2026, 4, 26, 3, 59, 59, 999),
    );
  });

  it('handles half-hour offsets (Asia/Kolkata, UTC+5:30)', () => {
    // Midnight Kolkata = previous day 18:30 UTC.
    expect(zonedTimeToUtcMs(2026, 6, 15, 0, 0, 0, 0, 'Asia/Kolkata')).toBe(
      Date.UTC(2026, 6, 14, 18, 30, 0, 0),
    );
  });

  it('round-trips: the result renders back as the input wall-clock in that zone', () => {
    const tz = 'America/Los_Angeles';
    const ms = zonedTimeToUtcMs(2026, 4, 25, 0, 0, 0, 0, tz);
    const wall = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(ms));
    expect(wall).toContain('2026-05-25');
    expect(wall).toContain('00:00');
  });

  it('falls back to UTC for an invalid timezone', () => {
    expect(zonedTimeToUtcMs(2026, 4, 25, 0, 0, 0, 0, 'Not/AZone')).toBe(
      Date.UTC(2026, 4, 25, 0, 0, 0, 0),
    );
  });
});

describe('formatHeartbeatTime tooltip', () => {
  it('labels a real heartbeat as last seen', () => {
    const { tooltip } = formatHeartbeatTime(Math.floor(Date.now() / 1000) - 30, 'UTC', '24h');
    expect(tooltip).toMatch(/^last seen /);
  });

  it('says so when no heartbeat was ever received', () => {
    expect(formatHeartbeatTime(0).tooltip).toBe('no heartbeat received');
  });
});
