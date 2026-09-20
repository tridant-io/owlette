/** @jest-environment node */

/**
 * Tests for networkUtils.ts — throughput formatting rules. The unit-promotion
 * and trailing-".0" trim behavior is easy to regress, so pin them here.
 */

import { formatThroughput, formatThroughputShort } from '@/lib/networkUtils';

describe('formatThroughput', () => {
  it('rounds sub-KB values to whole bytes', () => {
    expect(formatThroughput(0)).toBe('0 B/s');
    expect(formatThroughput(1)).toBe('1 B/s');
    expect(formatThroughput(499.4)).toBe('499 B/s');
    expect(formatThroughput(1023)).toBe('1023 B/s');
  });

  it('trims trailing ".0" for whole-unit values', () => {
    expect(formatThroughput(1024)).toBe('1 KB/s');
    expect(formatThroughput(256_000)).toBe('250 KB/s');
    expect(formatThroughput(512_000)).toBe('500 KB/s');
    expect(formatThroughput(1_048_576)).toBe('1 MB/s');
    expect(formatThroughput(2_097_152)).toBe('2 MB/s');
    expect(formatThroughput(1_073_741_824)).toBe('1 GB/s');
  });

  it('keeps a single decimal for non-whole values', () => {
    expect(formatThroughput(1536)).toBe('1.5 KB/s');
    expect(formatThroughput(1_536_000)).toBe('1.5 MB/s');
    expect(formatThroughput(5_368_709_120 * 1.5)).toBe('7.5 GB/s');
  });

  it('promotes to the next unit at 1000 rather than 1024', () => {
    // 1000 KB (= 1_024_000 bytes) must read as "1 MB/s", not "1000 KB/s".
    expect(formatThroughput(1_024_000)).toBe('1 MB/s');
    // Just under 1000 KB (rounded to 1dp) stays in KB.
    expect(formatThroughput(999 * 1024)).toBe('999 KB/s');
    // Same rule at the MB→GB boundary.
    expect(formatThroughput(1000 * 1_048_576)).toBe('1 GB/s');
  });

  it('handles the rounding edge at 999.95 KB/s', () => {
    // toFixed(1) would render "1000.0 KB/s" — must promote to MB.
    expect(formatThroughput(999.95 * 1024)).toBe('1 MB/s');
  });
});

describe('formatThroughputShort', () => {
  // the machine card shows two of these plus arrows plus a loss badge in one
  // truncating column, so width is the requirement, not a preference.
  // five, not four: the 1000-1023 B window renders `1023B`. everything from a
  // kilobyte up is four or fewer, so the column sizes on 5.
  it('never exceeds five characters, and only bytes reach five', () => {
    for (const b of [0, 1, 1023, 1024, 2867, 8400, 99_000, 1_153_434, 12e6, 999e6, 5e9]) {
      expect(formatThroughputShort(b).length).toBeLessThanOrEqual(5);
    }
    expect(formatThroughputShort(1023)).toBe('1023B');
    for (const b of [1024, 2867, 99_000, 1_153_434, 999e6, 5e9]) {
      expect(formatThroughputShort(b).length).toBeLessThanOrEqual(4);
    }
  });

  it('keeps one decimal below ten, where it carries information', () => {
    expect(formatThroughputShort(2867)).toBe('2.8K');
    expect(formatThroughputShort(1_153_434)).toBe('1.1M');
    expect(formatThroughputShort(5e9)).toBe('4.7G');
  });

  it('drops the decimal at ten and above, where it is noise', () => {
    expect(formatThroughputShort(99_000)).toBe('97K');
    expect(formatThroughputShort(12e6)).toBe('11M');
    expect(formatThroughputShort(999e6)).toBe('953M');
  });

  it('trims a trailing .0 and keeps bytes whole', () => {
    expect(formatThroughputShort(0)).toBe('0B');
    expect(formatThroughputShort(512)).toBe('512B');
    expect(formatThroughputShort(1024)).toBe('1K');
  });
});
