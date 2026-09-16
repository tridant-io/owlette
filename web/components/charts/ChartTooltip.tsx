'use client';

/** Recharts hover tooltip for the metric charts. */

import { ArrowDown, ArrowUp, Thermometer } from 'lucide-react';
import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO, isDiskIOKey, parseDiskIOKey } from '@/lib/diskIOUtils';

export type MetricType = 'cpu' | 'memory' | 'disk' | 'gpu' | 'cpuTemp' | 'gpuTemp' | 'display';

// Explicit colors: CSS variables don't resolve in SVG stroke attributes.
export const metricConfig: Record<MetricType, { label: string; color: string; unit: string }> = {
  cpu: { label: 'CPU', color: 'oklch(0.75 0.18 195)', unit: '%' },       // cyan accent (matches --accent-cyan)
  memory: { label: 'RAM', color: 'oklch(0.65 0.25 250)', unit: '%' },    // blue (matches sidebar-primary)
  disk: { label: 'Disk', color: 'rgb(34, 197, 94)', unit: '%' },         // green-500
  gpu: { label: 'GPU', color: 'rgb(249, 115, 22)', unit: '%' },          // orange-500
  cpuTemp: { label: 'CPU', color: 'rgb(239, 68, 68)', unit: '°C' },      // red-500 — thermometer icon disambiguates from cpu
  gpuTemp: { label: 'GPU', color: 'rgb(236, 72, 153)', unit: '°C' },     // pink-500 — thermometer icon disambiguates from gpu
  display: { label: 'Displays', color: 'oklch(0.70 0.15 280)', unit: '' }, // purple — display topology (not a time-series metric)
};

/** e.g. "Ethernet_tx_util", "Wi-Fi_rx_util". */
export function isNetworkMetricKey(key: string): boolean {
  return key.endsWith('_tx_util') || key.endsWith('_rx_util');
}

/**
 * Parse a per-NIC key from either family — percent (`_tx_util`/`_rx_util`) or
 * raw bytes (`_tx`/`_rx`) — since MetricsDetailPanel flips between them via
 * networkMode. Order matters: `_tx_util` also ends in `_tx`, so test it first.
 */
function parseNetworkKey(
  key: string,
): { nic: string; direction: 'TX' | 'RX'; isPct: boolean } | null {
  if (key.endsWith('_tx_util')) return { nic: key.slice(0, -'_tx_util'.length), direction: 'TX', isPct: true };
  if (key.endsWith('_rx_util')) return { nic: key.slice(0, -'_rx_util'.length), direction: 'RX', isPct: true };
  if (key.endsWith('_tx')) return { nic: key.slice(0, -'_tx'.length), direction: 'TX', isPct: false };
  if (key.endsWith('_rx')) return { nic: key.slice(0, -'_rx'.length), direction: 'RX', isPct: false };
  return null;
}

/**
 * Per-device disk *storage* keys ("C:_pct"). Excludes `_io_read_pct` /
 * `_io_write_pct`, which share the suffix but belong to the disk-IO branch.
 */
function parseDiskKey(key: string): { diskName: string } | null {
  if (!key.endsWith('_pct')) return null;
  if (key.endsWith('_io_read_pct') || key.endsWith('_io_write_pct')) return null;
  return { diskName: key.slice(0, -4) };
}

/** e.g. "GPU 0_usage", "GPU 0_temp". */
function parseGpuDeviceKey(key: string): { gpuName: string; field: 'usage' | 'temp' } | null {
  if (key.endsWith('_usage')) return { gpuName: key.slice(0, -6), field: 'usage' };
  if (key.endsWith('_temp')) return { gpuName: key.slice(0, -5), field: 'temp' };
  return null;
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | string;
  name?: string;
  color?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
  /** Optional: Override the default time formatter */
  formatTime?: (timestamp: number) => string;
  /** UUID -> friendly name for GPUs. Chart keys stay UUID-based; this only
   *  changes the displayed label. */
  gpuLabels?: ReadonlyMap<string, string>;
  /** Show only this series' row (a pinned stat card). The full payload stays
   *  available for sibling lookups, e.g. the bytes behind a percent NIC row. */
  onlyKey?: string;
}

function defaultFormatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChartTooltip({ active, payload, label, formatTime = defaultFormatTime, gpuLabels, onlyKey }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  // `label` is the timestamp in ms.
  const timestamp = typeof label === 'number' ? label : parseInt(label as string, 10);

  return (
    <div className="bg-popover border border-border rounded-lg shadow-lg p-3 min-w-[140px]">
      <p className="text-xs text-muted-foreground mb-2">
        {formatTime(timestamp)}
      </p>

      <div className="space-y-1">
        {payload.map((entry, _index) => {
          const key = String(entry.dataKey ?? '');
          if (onlyKey !== undefined && key !== onlyKey) return null;
          const config = metricConfig[key as MetricType];
          const netInfo = !config ? parseNetworkKey(key) : null;
          const diskInfo = !config && !netInfo ? parseDiskKey(key) : null;
          const gpuInfo = !config && !netInfo && !diskInfo ? parseGpuDeviceKey(key) : null;
          const diskIOChannel = !config && !netInfo && !diskInfo && !gpuInfo && isDiskIOKey(key) ? parseDiskIOKey(key) : null;

          if (!config && !netInfo && !diskInfo && !gpuInfo && !diskIOChannel) return null;
          if (entry.value === undefined || entry.value === null) return null;

          // Per-NIC rows. Percent mode: `_util` is visible and the bytes
          // sibling is a hidden Line in the payload — render "0.9% (1 MB/s)"
          // and skip the bytes entry so the direction renders once. Bytes mode:
          // no `_util` sibling, render throughput alone (the absolute number is
          // what matters when utilization is sub-1%).
          if (netInfo) {
            if (!netInfo.isPct && payload.some(e => String(e.dataKey) === `${key}_util`)) {
              return null;
            }
            const DirectionIcon = netInfo.direction === 'TX' ? ArrowUp : ArrowDown;
            if (!netInfo.isPct) {
              const bytes = typeof entry.value === 'number' ? entry.value : Number(entry.value) || 0;
              return (
                <div key={key} className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                    <span className="text-sm text-foreground inline-flex items-center gap-1">
                      {netInfo.nic}
                      <DirectionIcon className="h-3 w-3" />
                    </span>
                  </div>
                  <span className="text-sm font-medium text-foreground">{formatThroughput(bytes)}</span>
                </div>
              );
            }
            const throughputKey = key.replace('_util', '');  // "Ethernet_tx"
            const throughputEntry = payload.find(e => String(e.dataKey) === throughputKey);
            const throughput = typeof throughputEntry?.value === 'number' ? throughputEntry.value : 0;
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  <span className="text-sm text-foreground inline-flex items-center gap-1">
                    {netInfo.nic}
                    <DirectionIcon className="h-3 w-3" />
                  </span>
                </div>
                <span className="text-sm font-medium text-foreground">
                  {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}%
                  <span className="text-muted-foreground ml-1">({formatThroughput(throughput)})</span>
                </span>
              </div>
            );
          }

          if (diskInfo) {
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  <span className="text-sm text-foreground">{diskInfo.diskName}</span>
                </div>
                <span className="text-sm font-medium text-foreground">{Number(entry.value).toFixed(1)}%</span>
              </div>
            );
          }

          // Temp rows get a Thermometer icon rather than the legacy degree suffix.
          if (gpuInfo) {
            const unit = gpuInfo.field === 'temp' ? '°C' : '%';
            const friendly = gpuLabels?.get(gpuInfo.gpuName) ?? gpuInfo.gpuName;
            const isTemp = gpuInfo.field === 'temp';
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  <span className="text-sm text-foreground inline-flex items-center gap-1">
                    {friendly}
                    {isTemp && <Thermometer className="h-3 w-3" />}
                  </span>
                </div>
                <span className="text-sm font-medium text-foreground">{Number(entry.value).toFixed(1)}{unit}</span>
              </div>
            );
          }

          // Per-volume disk IO. Two key families per (volume, channel):
          // bytes/sec and percent-of-max. The tooltip always shows bytes/sec,
          // reading the hidden sibling in percent mode. Skip the bytes entry
          // when both are present, or the channel renders twice.
          if (diskIOChannel) {
            if (!diskIOChannel.isPct && payload.some(e => String(e.dataKey) === `${key}_pct`)) {
              return null;
            }
            const label = `${diskIOChannel.id} ${diskIOChannel.channel}`;
            const dotColor = DISK_IO_COLORS[diskIOChannel.channel];
            let bytes: number;
            if (diskIOChannel.isPct) {
              const bytesKey = key.replace(/_pct$/, '');
              const bytesEntry = payload.find(e => String(e.dataKey) === bytesKey);
              bytes = typeof bytesEntry?.value === 'number' ? bytesEntry.value : 0;
            } else {
              bytes = typeof entry.value === 'number' ? entry.value : Number(entry.value) || 0;
            }
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dotColor }} />
                  <span className="text-sm text-foreground">{label}</span>
                </div>
                <span className="text-sm font-medium text-foreground">{formatDiskIO(bytes)}</span>
              </div>
            );
          }

          // `cpuTemp`/`gpuTemp` share the base metric's label, so the
          // Thermometer icon is the only thing preventing two "CPU" rows.
          const isTempMetric = key === 'cpuTemp' || key === 'gpuTemp';
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: config.color }}
                />
                <span className="text-sm text-foreground inline-flex items-center gap-1">
                  {config.label}
                  {isTempMetric && <Thermometer className="h-3 w-3" />}
                </span>
              </div>
              <span className="text-sm font-medium text-foreground">
                {typeof entry.value === 'number' ? entry.value.toFixed(1) : entry.value}
                {config.unit}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
