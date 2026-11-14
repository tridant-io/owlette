import type { MemoryMetric } from '@/hooks/useFirestore';

/**
 * the machine's ram total in GB, or null when nothing can say.
 *
 * the heartbeat carries `total_gb` and it wins. the recovery from
 * `usedGb / percent` is only for a heartbeat without it, and it is only right
 * on windows: there psutil's `used` is `total - available`, the same pair
 * `percent` is built from. on macos and linux `used` leaves out inactive and
 * cached pages while `percent` counts them, so the quotient collapses — a
 * 16 GB macbook air read as 7.7 GB (2026-09-25).
 */
export function resolveMemoryTotalGb(memory: MemoryMetric | undefined): number | null {
  if (!memory) return null;
  if (typeof memory.totalGb === 'number' && memory.totalGb > 0) return memory.totalGb;
  if (memory.usedGb != null && memory.percent != null && memory.percent > 0) {
    return memory.usedGb / (memory.percent / 100);
  }
  return null;
}
