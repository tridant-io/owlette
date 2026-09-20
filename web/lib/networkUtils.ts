/**
 * bytes/sec → human-readable. Binary units (1 KB = 1024 B), matching memory/disk elsewhere,
 * but promotes at 1000 so "1000 KB/s" never appears. Trailing ".0" trimmed.
 */
export function formatThroughput(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  const units = ['KB/s', 'MB/s', 'GB/s'];
  let v = bytesPerSec / 1024;
  let i = 0;
  while (i < units.length - 1 && Math.round(v * 10) / 10 >= 1000) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1).replace(/\.0$/, '')} ${units[i]}`;
}

/**
 * Compact rate for tight cells: `1.1M`, `8.2K`, `0.9K`.
 *
 * No unit suffix and no `/s`: on the machine card the `net` label and the
 * up/down arrows already say what it is, and two full-length rates plus a
 * loss badge do not fit the column — it truncated to `↓8…`.
 *
 * Kilobytes are the floor. `907B` and `0.9K` are the same width but mixing
 * units across a pair of numbers that sit side by side is what made the cell
 * hard to read — and dropping bytes caps the width at four, since `1023B` was
 * the only five-character case.
 *
 * One decimal below 10, where it is the difference between 1.1M and 1.9M;
 * above that it is noise on a number that moves every second.
 */
export function formatThroughputShort(bytesPerSec: number): string {
  const units = ['K', 'M', 'G'];
  let v = bytesPerSec / 1024;
  let i = 0;
  while (i < units.length - 1 && v >= 1024) {
    v /= 1024;
    i++;
  }
  const n = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${n}${units[i]}`;
}

/** Per-NIC chart colors, [TX, RX]. */
export const NIC_COLORS: [string, string][] = [
  ['rgb(251, 146, 60)', 'rgb(74, 222, 128)'],    // orange-400 / green-400
  ['rgb(245, 158, 11)', 'rgb(45, 212, 191)'],    // amber-500 / teal-400
  ['rgb(244, 63, 94)', 'rgb(96, 165, 250)'],     // rose-500 / blue-400
];

/** TX/RX pair by NIC index; wraps past the end of the table. */
export function getNicColors(index: number): { tx: string; rx: string } {
  const pair = NIC_COLORS[index % NIC_COLORS.length];
  return { tx: pair[0], rx: pair[1] };
}

/** Per-disk chart colors. */
const DISK_COLORS = [
  'oklch(0.72 0.14 155)',  // green (like current disk but per-device)
  'oklch(0.68 0.16 185)',  // teal
  'oklch(0.65 0.14 280)',  // purple
  'oklch(0.70 0.16 85)',   // amber
  'oklch(0.62 0.12 230)',  // slate blue
];

/** Disk color by index; wraps past the end of the table. */
export function getDiskColors(index: number): string {
  return DISK_COLORS[index % DISK_COLORS.length];
}

/** Per-GPU chart colors, [usage (warm), temperature (cool)]. */
const GPU_COLORS: { usage: string; temp: string }[] = [
  { usage: 'oklch(0.72 0.19 55)',  temp: 'oklch(0.65 0.22 25)' },   // orange / red-orange
  { usage: 'oklch(0.70 0.18 130)', temp: 'oklch(0.63 0.20 100)' },  // green / yellow-green
  { usage: 'oklch(0.68 0.20 270)', temp: 'oklch(0.60 0.22 300)' },  // purple / magenta
];

/** Usage/temp pair by GPU index; wraps past the end of the table. */
export function getGpuColors(index: number): { usage: string; temp: string } {
  return GPU_COLORS[index % GPU_COLORS.length];
}
