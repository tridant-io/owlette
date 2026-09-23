/** @jest-environment node */

/**
 * Tests for diskIOUtils.ts: DISK_IO_COLORS shape, formatDiskIO delegation to
 * formatThroughput, isDiskIOKey regex anchoring, parseDiskIOKey id+channel extraction.
 */

import {
  DISK_IO_COLORS,
  formatDiskIO,
  isDiskIOKey,
  parseDiskIOKey,
  computeNiceByteTicks,
} from '@/lib/diskIOUtils';
import { formatThroughput } from '@/lib/networkUtils';

describe('DISK_IO_COLORS', () => {
  it('exposes exactly read/write entries', () => {
    expect(Object.keys(DISK_IO_COLORS).sort()).toEqual(['read', 'write']);
  });

  it('uses the same green for read as NIC RX (convention parity)', () => {
    expect(DISK_IO_COLORS.read).toBe('rgb(74, 222, 128)');
  });

  it('uses the same orange for write as NIC TX (convention parity)', () => {
    expect(DISK_IO_COLORS.write).toBe('rgb(251, 146, 60)');
  });
});

describe('formatDiskIO', () => {
  // formatDiskIO delegates to formatThroughput — any future divergence is
  // intentional and should surface as a failing test we update together.
  it.each([
    [0],
    [500],
    [1024],
    [1_048_576],          // 1 MiB
    [1_073_741_824],      // 1 GiB
    [1_234_567_890],
  ])('matches formatThroughput(%i)', (v) => {
    expect(formatDiskIO(v)).toBe(formatThroughput(v));
  });
});

describe('isDiskIOKey', () => {
  it('matches the two per-volume activity channels in both pct and bytes form', () => {
    expect(isDiskIOKey('C:_io_read_pct')).toBe(true);
    expect(isDiskIOKey('C:_io_write_pct')).toBe(true);
    expect(isDiskIOKey('C:_io_read')).toBe(true);
    expect(isDiskIOKey('C:_io_write')).toBe(true);
  });

  it('matches regardless of volume id shape', () => {
    expect(isDiskIOKey('L:_io_read_pct')).toBe(true);
    expect(isDiskIOKey('PhysicalDrive0_io_write_pct')).toBe(true);
    expect(isDiskIOKey('/mnt/data_io_read_pct')).toBe(true);
    expect(isDiskIOKey('L:_io_read')).toBe(true);
    expect(isDiskIOKey('PhysicalDrive0_io_write')).toBe(true);
  });

  it('rejects the unused busy key', () => {
    // `_io_busy` is still emitted (PercentDiskTime) but not wired to any
    // chart line today, so disk-IO routing should skip it.
    expect(isDiskIOKey('C:_io_busy')).toBe(false);
  });

  it('rejects the v1 aggregate keys', () => {
    expect(isDiskIOKey('diskIO_read')).toBe(false);
    expect(isDiskIOKey('diskIO_write')).toBe(false);
    expect(isDiskIOKey('diskIO_busy')).toBe(false);
  });

  it('rejects other per-device patterns', () => {
    expect(isDiskIOKey('Ethernet_tx')).toBe(false);
    expect(isDiskIOKey('Ethernet_rx_util')).toBe(false);
    expect(isDiskIOKey('C:_pct')).toBe(false);
    expect(isDiskIOKey('NVIDIA_usage')).toBe(false);
    expect(isDiskIOKey('NVIDIA_temp')).toBe(false);
  });

  it('rejects invalid channels and empty/garbage', () => {
    expect(isDiskIOKey('')).toBe(false);
    expect(isDiskIOKey('C:_io_')).toBe(false);
    expect(isDiskIOKey('C:_io_latency_pct')).toBe(false);
    expect(isDiskIOKey('_io_read_pct')).toBe(false); // empty id
    expect(isDiskIOKey('_io_read')).toBe(false); // empty id
    expect(isDiskIOKey('C:_io_read_pct_extra')).toBe(false); // suffix-only anchor
    expect(isDiskIOKey('C:_io_read_extra')).toBe(false); // suffix-only anchor
  });
});

describe('parseDiskIOKey', () => {
  it('extracts id, channel, and isPct=true for the percent variant', () => {
    expect(parseDiskIOKey('C:_io_read_pct')).toEqual({ id: 'C:', channel: 'read', isPct: true });
    expect(parseDiskIOKey('C:_io_write_pct')).toEqual({ id: 'C:', channel: 'write', isPct: true });
  });

  it('extracts id, channel, and isPct=false for the bytes variant', () => {
    expect(parseDiskIOKey('C:_io_read')).toEqual({ id: 'C:', channel: 'read', isPct: false });
    expect(parseDiskIOKey('C:_io_write')).toEqual({ id: 'C:', channel: 'write', isPct: false });
  });

  it('handles different volume id shapes', () => {
    expect(parseDiskIOKey('L:_io_read_pct')).toEqual({ id: 'L:', channel: 'read', isPct: true });
    expect(parseDiskIOKey('PhysicalDrive0_io_write_pct')).toEqual({
      id: 'PhysicalDrive0',
      channel: 'write',
      isPct: true,
    });
    expect(parseDiskIOKey('L:_io_write')).toEqual({ id: 'L:', channel: 'write', isPct: false });
  });

  it('returns null for the unused busy sibling', () => {
    expect(parseDiskIOKey('C:_io_busy')).toBeNull();
  });

  it('returns null for the v1 aggregate keys', () => {
    expect(parseDiskIOKey('diskIO_read')).toBeNull();
    expect(parseDiskIOKey('diskIO_write')).toBeNull();
  });

  it('returns null for non-disk-IO keys', () => {
    expect(parseDiskIOKey('Ethernet_tx')).toBeNull();
    expect(parseDiskIOKey('C:_pct')).toBeNull();
    expect(parseDiskIOKey('NVIDIA_usage')).toBeNull();
  });

  it('returns null for garbage', () => {
    expect(parseDiskIOKey('')).toBeNull();
    expect(parseDiskIOKey('foo')).toBeNull();
    expect(parseDiskIOKey('C:_io_')).toBeNull();
    expect(parseDiskIOKey('C:_io_latency_pct')).toBeNull();
    expect(parseDiskIOKey('_io_read_pct')).toBeNull();
    expect(parseDiskIOKey('_io_read')).toBeNull();
  });

  it('narrows the channel return type to the literal union', () => {
    const parsed = parseDiskIOKey('C:_io_write_pct');
    // If the cast in parseDiskIOKey is wrong this test fails at compile time.
    if (parsed) {
      const channel: 'read' | 'write' = parsed.channel;
      expect(channel).toBe('write');
    }
  });
});

describe('computeNiceByteTicks', () => {
  it('returns null for non-positive or non-finite input', () => {
    expect(computeNiceByteTicks(0)).toBeNull();
    expect(computeNiceByteTicks(-1)).toBeNull();
    expect(computeNiceByteTicks(Number.NaN)).toBeNull();
    expect(computeNiceByteTicks(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('picks 250 KB/s steps for a ~500 KB/s peak', () => {
    // 500 KB = 512 000 bytes, rough = 128 000, step = 250 KB (256 000).
    const result = computeNiceByteTicks(512_000);
    expect(result).toEqual({
      domainMax: 1_024_000,
      ticks: [0, 256_000, 512_000, 768_000, 1_024_000],
    });
    expect(result!.ticks.map(formatDiskIO)).toEqual(['0 B/s', '250 KB/s', '500 KB/s', '750 KB/s', '1 MB/s']);
  });

  it('picks 500 KB/s steps for a ~1.1 MB/s peak', () => {
    // The regression case from the bug report.
    const result = computeNiceByteTicks(1_153_434);
    expect(result).toEqual({
      domainMax: 2_048_000,
      ticks: [0, 512_000, 1_024_000, 1_536_000, 2_048_000],
    });
  });

  it('picks 1 MB/s steps for a ~3 MB/s peak', () => {
    // rough = 786 432 → smallest nice step ≥ that is 1 MB (1 048 576);
    // step 500 KB (512 000) is too small.
    const result = computeNiceByteTicks(3_145_728);
    expect(result).toEqual({
      domainMax: 4_194_304,
      ticks: [0, 1_048_576, 2_097_152, 3_145_728, 4_194_304],
    });
    expect(result!.ticks.map(formatDiskIO)).toEqual([
      '0 B/s',
      '1 MB/s',
      '2 MB/s',
      '3 MB/s',
      '4 MB/s',
    ]);
  });

  it('picks 2 MB/s steps for a ~5 MB/s peak', () => {
    const result = computeNiceByteTicks(5_000_000);
    expect(result).toEqual({
      domainMax: 8_388_608,
      ticks: [0, 2_097_152, 4_194_304, 6_291_456, 8_388_608],
    });
    expect(result!.ticks.map(formatDiskIO)).toEqual([
      '0 B/s',
      '2 MB/s',
      '4 MB/s',
      '6 MB/s',
      '8 MB/s',
    ]);
  });

  it('stays in the byte range for sub-KB peaks', () => {
    const result = computeNiceByteTicks(300);
    // rough = 75, smallest nice mantissa ≥ 75 is 100.
    expect(result).toEqual({
      domainMax: 400,
      ticks: [0, 100, 200, 300, 400],
    });
  });

  it('covers the input on four even steps', () => {
    // 5e12 is past every candidate step and exercises the multiple-of-largest fallback.
    for (const v of [1, 999, 100_000, 1_234_567, 987_654_321, 5e12]) {
      const result = computeNiceByteTicks(v);
      expect(result).not.toBeNull();
      const step = result!.ticks[1];
      expect(result!.ticks).toEqual([0, step, step * 2, step * 3, step * 4]);
      expect(result!.domainMax).toBe(step * 4);
      expect(result!.domainMax).toBeGreaterThanOrEqual(v);
    }
  });
});
