/**
 * Disk IO monitoring utilities — throughput formatting, chart colors, key
 * helpers. Chart data carries two parallel key families per channel:
 * `{volumeId}_io_{channel}` (bytes/sec) and `..._pct` (percent of max
 * bandwidth); `isDiskIOKey` / `parseDiskIOKey` accept both. MetricsDetailPanel
 * binds percent near saturation and bytes when activity would flatline.
 */

import { formatThroughput } from './networkUtils';

/** Chart line colors for per-volume disk IO activity series. */
export const DISK_IO_COLORS = {
  read: 'rgb(74, 222, 128)',   // green - matches NIC RX convention
  write: 'rgb(251, 146, 60)',  // orange - matches NIC TX convention
} as const;

/** Format a byte-rate (bytes/sec) as a human-readable throughput string. */
export function formatDiskIO(bytesPerSec: number): string {
  return formatThroughput(bytesPerSec);
}

/** Matches `{volumeId}_io_read|write` and its `_pct` variant; `_io_busy` and unknown channels are rejected. */
export function isDiskIOKey(key: string): boolean {
  return /^.+_io_(read|write)(_pct)?$/.test(key);
}

/** Parse a disk IO key into { id, channel, isPct }, or null. `isPct` marks the %-of-max variant. */
export function parseDiskIOKey(
  key: string,
): { id: string; channel: 'read' | 'write'; isPct: boolean } | null {
  const match = /^(.+?)_io_(read|write)(_pct)?$/.exec(key);
  return match
    ? {
        id: match[1],
        channel: match[2] as 'read' | 'write',
        isPct: match[3] === '_pct',
      }
    : null;
}

/** Round-number Y-axis ticks for a bytes/sec chart, on four even steps so they share
 *  the chart's quarter gridlines with every other axis. Recharts divides the max by 4
 *  and produces ticks like "585.9 KB/s"; this picks the smallest step from nice
 *  mantissas × binary bases whose four steps cover the max, so every tick formats
 *  cleanly. Null for a non-positive or non-finite max. */
export function computeNiceByteTicks(
  maxBytesPerSec: number,
): { domainMax: number; ticks: number[] } | null {
  if (!Number.isFinite(maxBytesPerSec) || maxBytesPerSec <= 0) return null;

  // 256/512 are omitted by design: humans expect "250 KB", "500 KB", "1 MB".
  const mantissas = [1, 2, 5, 10, 25, 50, 100, 250, 500];
  const bases = [1, 1024, 1024 * 1024, 1024 * 1024 * 1024];

  // Smallest candidate ≥ max/4, so four steps cover the max.
  const rough = maxBytesPerSec / 4;
  let step = 0;
  outer: for (const base of bases) {
    for (const m of mantissas) {
      const s = m * base;
      if (s >= rough) {
        step = s;
        break outer;
      }
    }
  }
  // Past the largest candidate (500 GB/s), round up to a multiple of it rather than bail out.
  if (step === 0) {
    const largest = mantissas[mantissas.length - 1] * bases[bases.length - 1];
    step = Math.ceil(rough / largest) * largest;
  }

  return { domainMax: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}
