/**
 * Machines table with expandable process rows. Hidden on mobile; the dashboard toggles it
 * against card view on desktop.
 */

'use client';

import React, { memo, useEffect, useRef, useState } from 'react';
import { useMinuteTick } from '@/hooks/useMinuteTick';
import { TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { MachineStatusPill } from '@/components/MachineStatusPill';
import { useDemoContext } from '@/contexts/DemoContext';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, Pencil, Copy, Square, Plus, Clock, Monitor, Cog, Settings2, MoreVertical, BellOff, RotateCcw } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/contexts/AuthContext';
import { formatScheduleSummary } from '@/components/ScheduleEditor';
import { BLOCK_COLORS } from '@/lib/scheduleDefaults';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { formatStorageRange } from '@/lib/storageUtils';
import { getUsageColorClass } from '@/lib/usageColorUtils';
import { formatHeartbeatTime, formatMachineLocalClock, formatTimezoneShortName, getDisplayTimezone } from '@/lib/timeUtils';
import { machineClockTooltip } from '@/lib/scheduleClockCopy';
import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO } from '@/lib/diskIOUtils';
import { resolveDevice } from '@/lib/deviceResolvers';
import { type DeviceKind, type DeviceSelection } from '@/hooks/useDevicePrefs';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

/** Per-kind device id union across visible machines; populates the column-header dropdowns. */
export interface DeviceUnion {
  cpus: string[];
  disks: string[];
  gpus: string[];
  nics: string[];
}

/** Which column headers should render a device dropdown (vs. plain label). */
export interface ShowDropdownFlags {
  cpu: boolean;
  disk: boolean;
  gpu: boolean;
  nic: boolean;
}

interface DeviceColumnHeaderProps {
  label: string;
  kind: DeviceKind;
  showDropdown: boolean;
  ids: string[];
  selectedId: string | undefined;
  onSelect: (kind: DeviceKind, id: string | null) => void;
}

function DeviceColumnHeader({
  label,
  kind,
  showDropdown,
  ids,
  selectedId,
  onSelect,
}: DeviceColumnHeaderProps) {
  if (!showDropdown) {
    return <>{label}</>;
  }
  const displayLabel = selectedId ? `${label}: ${selectedId}` : label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-foreground hover:text-white cursor-pointer"
        >
          <span>{displayLabel}</span>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-secondary">
        <DropdownMenuRadioGroup
          value={selectedId ?? ''}
          onValueChange={(value) => onSelect(kind, value === '' ? null : value)}
        >
          <DropdownMenuRadioItem value="" className="cursor-pointer">
            auto (most active)
          </DropdownMenuRadioItem>
          {ids.map((id) => (
            <DropdownMenuRadioItem key={id} value={id} className="cursor-pointer">
              {id}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * COLUMN WIDTH BUDGET — keep both headers and `MachineRow`'s cells in sync.
 *
 * The table is `tableLayout: 'fixed'`, so these declared widths ARE the layout at
 * each tier's narrowest viewport; above that the surplus is distributed
 * proportionally, and below it the columns do NOT shrink — the table just
 * overflows its card into a horizontal scrollbar. So each tier's sum must clear
 * the container at that tier's breakpoint: `main` is `p-3 md:p-4` and the card
 * adds a 1px border, leaving `viewport - 26` below md and `viewport - 34` from md.
 *
 *   tier        sum   container at breakpoint
 *   sm  (640)   542   614
 *   md  (768)   638   734
 *   lg (1024)   978   990   ← binding constraint
 *   xl (1280)  1108  1246
 *
 * lg used to sum to 1034 against 990, which scrolled sideways from 1024 up to
 * ~1065 — the one band where every column is declared but the viewport hasn't
 * caught up. Adding or widening a column here means re-checking that row.
 *
 * The trailing actions column is `w-12`, not `w-10`: its trigger is `h-8 w-8`
 * and the cell's `p-2` leaves only 24px, so at w-10 the button rendered flush
 * against the card's right border.
 */

/** Plain-label header for callers (demo, dashboard) that render the table directly and
 * don't wire `deviceUnion` through. */
export const MemoizedTableHeader = memo(function MemoizedTableHeader() {
  return (
    <TableHeader className="sticky top-0 z-10 bg-card-header">
      <TableRow className="border-border/60 hover:bg-transparent">
        <TableHead className="text-foreground w-8"></TableHead>
        <TableHead className="text-foreground w-[130px]">hostname</TableHead>
        <TableHead className="text-foreground w-[72px]">status</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[150px] sm:overflow-visible sm:!px-2">cpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[110px] sm:overflow-visible sm:!px-2">ram</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[150px] lg:overflow-visible lg:!px-2">disk</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[190px] lg:overflow-visible lg:!px-2">gpu</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 xl:w-[130px] xl:overflow-visible xl:!px-2">network</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 md:w-[96px] md:overflow-visible md:!px-2">last heartbeat</TableHead>
        <TableHead className="text-foreground w-12"></TableHead>
      </TableRow>
    </TableHeader>
  );
});

interface MachineTableHeaderProps {
  deviceUnion: DeviceUnion;
  showDropdown: ShowDropdownFlags;
  listPref: DeviceSelection;
  setListPref: (kind: DeviceKind, id: string | null) => void;
}

// Memoized against metrics-tick flicker. Memo compares props by reference, so callers must
// pass stable listPref/setListPref and a memoized deviceUnion/showDropdown.
export const MachineTableHeader = memo(function MachineTableHeader({
  deviceUnion,
  showDropdown,
  listPref,
  setListPref,
}: MachineTableHeaderProps) {
  return (
    <TableHeader className="sticky top-0 z-10 bg-card-header">
      <TableRow className="border-border/60 hover:bg-transparent">
        <TableHead className="text-foreground w-8"></TableHead>
        <TableHead className="text-foreground w-[130px]">hostname</TableHead>
        <TableHead className="text-foreground w-[72px]">status</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[150px] sm:overflow-visible sm:!px-2">
          <DeviceColumnHeader
            label="cpu"
            kind="cpu"
            showDropdown={showDropdown.cpu}
            ids={deviceUnion.cpus}
            selectedId={listPref.cpu}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 sm:w-[110px] sm:overflow-visible sm:!px-2">ram</TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[150px] lg:overflow-visible lg:!px-2">
          <DeviceColumnHeader
            label="disk"
            kind="disk"
            showDropdown={showDropdown.disk}
            ids={deviceUnion.disks}
            selectedId={listPref.disk}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 lg:w-[190px] lg:overflow-visible lg:!px-2">
          <DeviceColumnHeader
            label="gpu"
            kind="gpu"
            showDropdown={showDropdown.gpu}
            ids={deviceUnion.gpus}
            selectedId={listPref.gpu}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 xl:w-[130px] xl:overflow-visible xl:!px-2">
          <DeviceColumnHeader
            label="network"
            kind="nic"
            showDropdown={showDropdown.nic}
            ids={deviceUnion.nics}
            selectedId={listPref.nic}
            onSelect={setListPref}
          />
        </TableHead>
        <TableHead className="text-foreground w-0 overflow-hidden !px-0 md:w-[96px] md:overflow-visible md:!px-2">last heartbeat</TableHead>
        <TableHead className="text-foreground w-12"></TableHead>
      </TableRow>
    </TableHeader>
  );
});

interface MachineRowProps {
  machine: Machine;
  isExpanded: boolean;
  currentSiteId: string;
  siteTimezone: string;
  siteTimeFormat: '12h' | '24h';
  /**
   * `sites/{siteId}.schedulesFollowSiteTime`, straight off the Firestore
   * snapshot (`useCurrentSite` / `useSites`). Three-state: `undefined` = never
   * asked, `false` = declined, `true` = site time. Do not source it from
   * `GET /api/sites`, which collapses the first two. Left unset, the clock
   * tooltip renders exactly as it did before the site-time work.
   */
  schedulesFollowSiteTime?: boolean;
  userPreferences: { temperatureUnit: 'C' | 'F' };
  isSiteAdmin?: boolean;
  onToggleExpanded: () => void;
  onEditProcess: (process: Process) => void;
  onDuplicateProcess?: (process: Process) => void;
  onCreateProcess: () => void;
  onKillProcess: (processId: string, processName: string) => void;
  onRestartProcess: (processId: string, processName: string) => void;
  onSetLaunchMode: (processId: string, processName: string, mode: LaunchMode, exePath: string, schedules?: ScheduleBlock[] | null) => void;
  onConfigureSchedule?: (process: Process) => void;
  onRemoveMachine: () => void;
  onMetricClick?: (metricType: MetricType) => void;
  onRestart?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onCancelRestart?: () => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  showLocalClock?: boolean;
  /** Column-dropdown selection (cpu/disk/gpu/nic). Unset kinds fall back to the machine's
   * reported primary device, which is also what "auto (most active)" selects. */
  listPref?: DeviceSelection;
}

export function MachineRow({
  machine,
  isExpanded,
  currentSiteId,
  siteTimezone,
  siteTimeFormat,
  schedulesFollowSiteTime,
  userPreferences,
  isSiteAdmin,
  onToggleExpanded,
  onEditProcess,
  onDuplicateProcess,
  onCreateProcess,
  onKillProcess,
  onRestartProcess,
  onSetLaunchMode,
  onConfigureSchedule,
  onRemoveMachine,
  onMetricClick,
  onRestart,
  onShutdown,
  onCancelRestart,
  onScreenshot,
  onLiveView,
  showLocalClock,
  listPref,
}: MachineRowProps) {
  // Held keeps the row mounted through the close animation.
  // `animOpen` lags `isExpanded` by one frame on open so the row mounts at grid-rows-[0fr]
  // and CSS sees a transition to [1fr] — without the lag both renders see 1fr and nothing
  // animates.
  const [heldExpanded, setHeldExpanded] = useState(isExpanded);
  // False at seed so a mounted-as-expanded row still gets a real 0fr → 1fr transition.
  const [animOpen, setAnimOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (isExpanded && !heldExpanded) {
    setHeldExpanded(true);
  }
  useEffect(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    // Next frame, so the mount frame's grid-rows class commits and the transition has a
    // from-state.
    const raf = requestAnimationFrame(() => setAnimOpen(isExpanded));
    if (!isExpanded && heldExpanded) {
      closeTimerRef.current = setTimeout(() => setHeldExpanded(false), 220);
    }
    return () => {
      cancelAnimationFrame(raf);
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [isExpanded, heldExpanded]);
  const pref = listPref ?? {};
  const primary = machine.metrics?.primary;
  const cpuDevice = resolveDevice(machine.devices?.cpus, pref.cpu, primary?.cpu);
  const diskDevice = resolveDevice(machine.devices?.disks, pref.disk, primary?.disk);
  const gpuDevice = resolveDevice(machine.devices?.gpus, pref.gpu, primary?.gpu);
  const nicDevice = resolveDevice(machine.devices?.nics, pref.nic, primary?.nic);

  // v2 MemoryMetric doesn't report `totalGb`; derive it from usedGb/percent, and show used
  // alone when percent is 0/missing.
  const memoryPercent = machine.metrics?.memory?.percent ?? 0;
  const memoryUsedGb = machine.metrics?.memory?.usedGb;
  const memoryTotalGb =
    memoryUsedGb !== undefined && memoryPercent > 0
      ? Math.round((memoryUsedGb / memoryPercent) * 100 * 10) / 10
      : null;
  const isDemo = !!useDemoContext();
  const { userPreferences: fullPrefs } = useAuth();
  const isMuted = fullPrefs.mutedMachines.includes(machine.machineId);
  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Drift dot reads the heartbeat's `metrics.displayDriftCount` instead of opening per-row
  // subscriptions to displayProfiles + displayAssignments.
  const displayDriftCount = machine.metrics?.displayDriftCount ?? 0;

  // Display tz is per-machine, from the user's `timeDisplayMode` — see getDisplayTimezone.
  const displayTz = getDisplayTimezone(
    fullPrefs.timeDisplayMode || 'machine',
    fullPrefs.timezone,
    machine.machineTimezone,
    siteTimezone
  );
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, displayTz, siteTimeFormat);
  const isStale = !machine.online || !!machine.rebooting;
  // Dimmed, not faded: below ~75% the muted device labels fall under 4.5:1 contrast.
  const staleClass = isStale ? ' opacity-80' : '';

  // Machine-local clock under the hostname. The shared minute tick re-renders every row in
  // lockstep off a single app-wide interval.
  useMinuteTick();
  const localClock = formatMachineLocalClock(machine.machineTimezone, siteTimeFormat);
  const localTzShort = formatTimezoneShortName(machine.machineTimezone);
  // Non-null exactly when the machine has reported a timezone, so it doubles as
  // the render guard below. One line unless this site evaluates launch windows
  // in site time, which splits restarts (always machine-local, decision D2)
  // from the windows that now follow the site.
  const clockTooltip = machine.machineTimezone
    ? machineClockTooltip({
        machineTimezone: machine.machineTimezone,
        siteTimezone,
        schedulesFollowSiteTime,
        agentVersion: machine.agent_version,
      })
    : null;

  const handleRowClick = () => {
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    onToggleExpanded();
  };

  return (
    <>
      <TableRow
        data-testid="machine-row"
        className="border-border/50 bg-card-sunken hover:bg-secondary/30 cursor-pointer"
        onClick={handleRowClick}
      >
        <TableCell className="w-8 p-2">
          <div className="flex items-center justify-center">
            <ChevronDown
              className={`h-4 w-4 text-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none ${isExpanded ? '-rotate-180' : 'rotate-0'}`}
            />
          </div>
        </TableCell>
        <TableCell className="w-[130px] font-medium text-white select-text overflow-hidden">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <div className="relative flex-shrink-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMetricClick?.('display');
                      }}
                      data-testid="open-display-panel"
                      className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0"
                      aria-label="view displays"
                    >
                      <Monitor className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>view displays</p>
                  </TooltipContent>
                </Tooltip>
                {displayDriftCount > 0 && (
                  <span
                    className="absolute -top-0.5 -right-0.5 inline-block w-2 h-2 rounded-full bg-amber-500 pointer-events-none"
                    role="img"
                    aria-label={`${displayDriftCount} display change${displayDriftCount === 1 ? '' : 's'} from assigned`}
                    title={`${displayDriftCount} display change${displayDriftCount === 1 ? '' : 's'} from assigned`}
                  />
                )}
                {machine.displayBreakerTripped && (
                  <span
                    className={`absolute inline-block w-2 h-2 rounded-full bg-destructive pointer-events-none ${
                      displayDriftCount > 0 ? '-bottom-0.5 -right-0.5' : '-top-0.5 -right-0.5'
                    }`}
                    role="img"
                    aria-label="auto-restore disabled — circuit breaker tripped"
                    title="auto-restore disabled — circuit breaker tripped"
                  />
                )}
              </div>
              <span className="truncate">{machine.machineId}</span>
              {isMuted && <span title="alerts muted"><BellOff className="h-3 w-3 text-muted-foreground flex-shrink-0" /></span>}
            </div>
            {showLocalClock && clockTooltip && localClock && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[10px] text-muted-foreground/80 select-none cursor-help truncate ml-5">
                    {localTzShort}, {localClock}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="max-w-xs">{clockTooltip.machineLine}</p>
                  {clockTooltip.scheduleLine && (
                    <p className="max-w-xs mt-1">{clockTooltip.scheduleLine}</p>
                  )}
                  {clockTooltip.advisory && (
                    <p className="max-w-xs mt-1 text-amber-400">{clockTooltip.advisory}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </TableCell>
        <TableCell className="w-[72px] p-2">
          <MachineStatusPill
            online={machine.online}
            rebooting={machine.rebooting}
            shuttingDown={machine.shuttingDown}
            rebootScheduledAt={machine.rebootScheduledAt}
            shutdownScheduledAt={machine.shutdownScheduledAt}
            isSiteAdmin={isSiteAdmin}
            onCancel={onCancelRestart}
            tooltip={heartbeat.tooltip}
          />
        </TableCell>
        {/* CPU with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 sm:w-[150px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('cpu'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.cpu} color="cpu" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(cpuDevice?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {cpuDevice && typeof cpuDevice.percent === 'number' ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={cpuDevice.model || 'Unknown CPU'}>
                    {cpuDevice.model || 'Unknown CPU'}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {cpuDevice.percent}%
                    {typeof cpuDevice.temperature === 'number' && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                        {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                      </span>
                    )}
                  </div>
                </div>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* Memory with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 sm:w-[110px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('memory'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.memory} color="memory" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(memoryPercent)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {machine.metrics?.memory && memoryUsedGb !== undefined ? (
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{memoryPercent}%</div>
                  <div className="text-muted-foreground text-xs truncate">
                    {memoryTotalGb !== null
                      ? formatStorageRange(memoryUsedGb, memoryTotalGb)
                      : `${memoryUsedGb.toFixed(1)} GB`}
                  </div>
                </div>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* Disk with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 lg:w-[150px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('disk'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(diskDevice?.percent ?? 0)}`} />
            <div className="absolute inset-0 flex items-end gap-3 p-2 pl-2.5 overflow-hidden">
              {diskDevice && typeof diskDevice.percent === 'number' && typeof diskDevice.usedGb === 'number' ? (
                <>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{diskDevice.percent}%</div>
                    <div className="text-muted-foreground text-xs truncate" title={diskDevice.id}>
                      {typeof diskDevice.totalGb === 'number'
                        ? formatStorageRange(diskDevice.usedGb, diskDevice.totalGb)
                        : `${diskDevice.usedGb.toFixed(1)} GB`}
                    </div>
                  </div>
                  {(() => {
                    const io = machine.metrics?.diskio?.[diskDevice.id];
                    if (!io || (io.readBps === 0 && io.writeBps === 0)) return null;
                    return (
                      <div className="ml-auto flex-shrink-0 flex gap-1 text-xs font-medium">
                        <div className="flex flex-col text-right">
                          <span style={{ color: DISK_IO_COLORS.read }}>r</span>
                          <span style={{ color: DISK_IO_COLORS.write }}>w</span>
                        </div>
                        <div className="flex flex-col text-left tabular-nums">
                          <span style={{ color: DISK_IO_COLORS.read }}>{formatDiskIO(io.readBps)}</span>
                          <span style={{ color: DISK_IO_COLORS.write }}>{formatDiskIO(io.writeBps)}</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              ) : '-'}
            </div>
          </div>
        </TableCell>
        {/* GPU with Sparkline */}
        <TableCell
          className="text-white p-0 w-0 lg:w-[190px] overflow-hidden"
          onClick={(e) => { e.stopPropagation(); onMetricClick?.('gpu'); }}
        >
          <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
            <div className="opacity-80">
              <SparklineChart data={sparklineData.gpu.length > 0 ? sparklineData.gpu : []} color="gpu" height={52} loading={sparklineData.loading} />
            </div>
            <div className={`absolute left-0 top-0 bottom-0 w-0.5 ${getUsageColorClass(gpuDevice?.usagePercent ?? 0)}`} />
            <div className="absolute inset-0 flex items-center p-2 pl-2.5 overflow-hidden">
              {gpuDevice && gpuDevice.name && gpuDevice.name !== 'N/A' && typeof gpuDevice.usagePercent === 'number' ? (
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-muted-foreground truncate" title={gpuDevice.name}>
                    {gpuDevice.name}
                  </div>
                  <div className="text-sm font-semibold whitespace-nowrap">
                    {gpuDevice.usagePercent}%
                    {typeof gpuDevice.vramUsedGb === 'number' && typeof gpuDevice.vramTotalGb === 'number' && (
                      <span className="text-muted-foreground text-xs ml-1 font-normal">
                        ({formatStorageRange(gpuDevice.vramUsedGb, gpuDevice.vramTotalGb)})
                      </span>
                    )}
                    {typeof gpuDevice.temperature === 'number' && (
                      <span className={`ml-1 text-xs font-medium ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                        {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <span className="text-muted-foreground">N/A</span>
              )}
            </div>
          </div>
        </TableCell>
        {/* Network */}
        <TableCell
          className="text-white p-0 w-0 xl:w-[130px] overflow-hidden"
          onClick={(e) => {
            e.stopPropagation();
            if (nicDevice) onMetricClick?.(`${nicDevice.id}_tx_util` as MetricType);
          }}
        >
          {(() => {
            if (
              !nicDevice ||
              typeof nicDevice.txBps !== 'number' ||
              typeof nicDevice.rxBps !== 'number'
            ) {
              return <span className="text-muted-foreground text-xs p-2">-</span>;
            }
            const txUtil = nicDevice.txUtil ?? 0;
            const rxUtil = nicDevice.rxUtil ?? 0;
            const maxUtil = Math.max(txUtil, rxUtil);
            const linkSpeed = nicDevice.linkSpeedMbps;
            const titleText = typeof linkSpeed === 'number'
              ? `${nicDevice.id} (${linkSpeed} Mbps)`
              : nicDevice.id;
            return (
              <div className={`relative cursor-pointer hover:bg-muted/50 transition-colors overflow-hidden${staleClass}`}>
                <div className={`absolute left-0 top-1/2 -translate-y-1/2 h-[52px] w-0.5 ${getUsageColorClass(maxUtil)}`} />
                <div className="p-2 pl-2.5">
                  <div className="text-xs text-muted-foreground truncate" title={titleText}>
                    {nicDevice.id}
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-orange-400">{'\u2191 '}{formatThroughput(nicDevice.txBps)}</span>
                  </div>
                  <div className="text-xs font-medium">
                    <span className="text-green-400">{'\u2193 '}{formatThroughput(nicDevice.rxBps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
        </TableCell>
        <TableCell className="w-0 md:w-[96px] overflow-hidden p-0 md:p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`text-xs flex items-center gap-1 cursor-help ${heartbeat.isStale ? 'text-red-400' : 'text-muted-foreground'}`}
              >
                <Clock className="h-3 w-3" />
                {heartbeat.display}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{heartbeat.tooltip}</p>
            </TooltipContent>
          </Tooltip>
        </TableCell>
        <TableCell className="w-12 p-2" onClick={(e) => e.stopPropagation()}>
          {!isDemo && (
            <MachineContextMenu
              machineId={machine.machineId}
              machineName={machine.machineId}
              machineTimezone={machine.machineTimezone}
              siteId={currentSiteId}
              isOnline={machine.online}
              rebooting={machine.rebooting}
              shuttingDown={machine.shuttingDown}
              isSiteAdmin={isSiteAdmin}
              onRemoveMachine={onRemoveMachine}
              onRestart={onRestart}
              onShutdown={onShutdown}
              onCancelRestart={onCancelRestart}
              onScreenshot={onScreenshot}
              onLiveView={onLiveView}
              onViewDisplays={onMetricClick ? () => onMetricClick('display') : undefined}
              rebootSchedule={machine.rebootSchedule}
            />
          )}
        </TableCell>
      </TableRow>

      {/* Expanded Process Details Row — kept mounted while heldExpanded so
          the close animation can play; the grid-template-rows transition on
          the inner wrapper animates the height in/out. */}
      {heldExpanded && (
        <TableRow key={`${machine.machineId}-processes`} className="border-border/50">
          <TableCell colSpan={10} className="p-0 overflow-hidden">
            <div
              className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                animOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
              }`}
            >
            <div className="overflow-hidden min-h-0">
            {/* Sunken tray (bg-card-sunken) + raised bg-card enclosure — the
                same surface scheme the card view uses for its sections, so the
                processes panel clearly reads as offset from the bg-card machine
                row above. */}
            <div className="px-4 py-3 bg-card-sunken">
              {machine.processes && machine.processes.length > 0 ? (
                <>
                  {/* Section enclosure: one raised bg-card surface holding the
                      process rows, separated by hairline dividers — mirrors the
                      card view instead of the old floating bordered cards. */}
                  <div className="overflow-hidden rounded-lg border border-border/30 bg-card divide-y divide-border/60">
                    {machine.processes.map((process) => (
                      /* Below sm the control rail stacks under the process info
                         (full-width name/path block, buttons on their own line)
                         instead of wrap-packing into a ragged two-column mess.
                         From sm up this is the original wrapping row. */
                      <div key={process.id} className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-y-2 p-3">
                          {/* min-w-40 (not 0): see MachineCardView — at min-w-0 the
                              flex-1 name block never wraps and squeezes to 0px */}
                          <div className="flex-1 min-w-40">
                            <div className="flex items-center gap-2 mb-1">
                              <Cog className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="text-white font-medium truncate select-text">{process.name}</span>
                              <Badge className={`text-xs flex-shrink-0 select-none ${!machine.online ? 'bg-muted text-muted-foreground' : process.status === 'RUNNING' ? 'bg-green-600' : process.status === 'INACTIVE' ? 'bg-slate-600 text-slate-200' : process.status === 'LAUNCH_FAILED' || process.status === 'STOPPED' || process.status === 'KILLED' ? 'bg-red-600 text-white' : 'bg-yellow-600'}`}>
                                {(!machine.online ? 'unknown' : process.status === 'LAUNCH_FAILED' ? 'failed' : process.status).toLowerCase()}
                              </Badge>
                              {process.pid && <span className="text-xs text-muted-foreground flex-shrink-0 select-text">PID: {process.pid}</span>}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground select-text min-w-0">
                              <span className="truncate" title={process.exe_path}>{process.exe_path}</span>
                              {process.file_path && (
                                <>
                                  <span className="flex-shrink-0 text-muted-foreground/70">›</span>
                                  <span className="truncate" title={process.file_path}>{process.file_path}</span>
                                </>
                              )}
                            </div>
                            {((process._optimisticLaunchMode ?? process.launch_mode) === 'scheduled') && (process._optimisticSchedules ?? process.schedules) && (process._optimisticSchedules ?? process.schedules)!.length > 0 && (
                              <div className="flex items-center gap-1.5 text-[11px] mt-0.5">
                                <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                                <span className="truncate">
                                  {(process._optimisticSchedules ?? process.schedules)!.map((block, i) => {
                                    const colorIdx = block.colorIndex ?? i;
                                    const color = BLOCK_COLORS[colorIdx % BLOCK_COLORS.length];
                                    const summary = block.name || formatScheduleSummary([block], siteTimeFormat);
                                    return (
                                      <span key={i}>
                                        {i > 0 && <span className="text-muted-foreground"> · </span>}
                                        <span className={color.label}>{summary}</span>
                                      </span>
                                    );
                                  })}
                                </span>
                              </div>
                            )}
                          </div>
                          {(() => {
                            const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as LaunchMode;
                            return (
                              <>
                                {/* Desktop controls (lg+) */}
                                <div className="hidden lg:flex items-center gap-3 ml-4 flex-shrink-0">
                                  {!isSiteAdmin ? (
                                    // Non-admins are read-only: static mode pill, no toggle (which would 403).
                                    <div className="flex items-center h-8">
                                      <span className={`flex items-center px-3 text-sm font-medium rounded-md border bg-card ${currentMode === 'always' ? 'text-emerald-400 border-emerald-600/40' : currentMode === 'scheduled' ? 'text-blue-400 border-blue-600/40' : 'text-muted-foreground border-border'}`}>
                                        {currentMode === 'always' ? 'always on' : currentMode === 'scheduled' ? 'scheduled' : 'off'}
                                      </span>
                                    </div>
                                  ) : (
                                  <div className="flex items-stretch rounded-md overflow-hidden border border-border h-8">
                                    {(['off', 'always', 'scheduled'] as const).map((mode) => {
                                      const isActive = currentMode === mode;
                                      const labels = { off: 'off', always: 'always on', scheduled: 'scheduled' };
                                      const activeColors = {
                                        off: 'bg-muted text-foreground',
                                        always: 'bg-emerald-600 text-white',
                                        scheduled: 'bg-blue-600 text-white',
                                      };

                                      if (mode === 'scheduled') {
                                        return (
                                          <span key={mode} className={`flex items-stretch ${isActive ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground'}`}>
                                            <button
                                              onClick={() => !isActive && onSetLaunchMode(process.id, process.name, mode, process.exe_path)}
                                              className={`px-3 text-sm font-medium ${isActive ? 'cursor-default' : 'hover:bg-accent/50 cursor-pointer'} transition-colors`}
                                            >
                                              {labels[mode]}
                                            </button>
                                            <span className={`w-px ${isActive ? 'bg-blue-400/50' : 'bg-border'}`} />
                                            <Tooltip>
                                              <TooltipTrigger asChild>
                                                <button
                                                  onClick={() => onConfigureSchedule?.(process)}
                                                  className={`px-1.5 transition-colors cursor-pointer flex items-center ${isActive ? 'hover:bg-blue-500' : 'hover:bg-accent/50'}`}
                                                >
                                                  <Settings2 className="h-3.5 w-3.5" />
                                                </button>
                                              </TooltipTrigger>
                                              <TooltipContent>
                                                <p>configure schedule</p>
                                              </TooltipContent>
                                            </Tooltip>
                                          </span>
                                        );
                                      }

                                      return (
                                        <button
                                          key={mode}
                                          onClick={() => onSetLaunchMode(process.id, process.name, mode, process.exe_path)}
                                          className={`px-3 text-sm font-medium transition-all duration-500 cursor-pointer ${isActive ? activeColors[mode] : 'bg-card text-muted-foreground hover:bg-accent/50'}`}
                                        >
                                          {labels[mode]}
                                        </button>
                                      );
                                    })}
                                  </div>
                                  )}
                                  {isSiteAdmin && (
                                    <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onEditProcess(process)}
                                    className="bg-card border border-border text-foreground"
                                  >
                                    <Pencil className="h-3 w-3 mr-1" />
                                    edit
                                  </Button>
                                  {onDuplicateProcess && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onDuplicateProcess(process)}
                                    className="bg-card border border-border text-foreground"
                                  >
                                    <Copy className="h-3 w-3 mr-1" />
                                    duplicate
                                  </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onRestartProcess(process.id, process.name)}
                                    className="bg-card border border-border text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                  >
                                    <RotateCcw className="h-3 w-3 mr-1" />
                                    restart
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onKillProcess(process.id, process.name)}
                                    className="bg-card border border-border text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                  >
                                    <Square className="h-3 w-3 mr-1" />
                                    kill
                                  </Button>
                                    </>
                                  )}
                                </div>
                                {/* Compact controls (<lg) */}
                                <div className="flex lg:hidden items-center gap-2 sm:ml-2 flex-shrink-0">
                                  {!isSiteAdmin ? (
                                    // Non-admins are read-only: static mode pill, no write menu.
                                    <span className={`flex items-center px-2.5 h-8 text-xs font-medium rounded-md border bg-card ${currentMode === 'always' ? 'text-emerald-400 border-emerald-600/40' : currentMode === 'scheduled' ? 'text-blue-400 border-blue-600/40' : 'text-muted-foreground border-border'}`}>
                                      {currentMode === 'always' ? 'always on' : currentMode === 'scheduled' ? 'scheduled' : 'off'}
                                    </span>
                                  ) : (
                                    <>
                                  <DropdownMenu>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <DropdownMenuTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0"
                                          >
                                            <MoreVertical className="h-4 w-4" />
                                          </Button>
                                        </DropdownMenuTrigger>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>more options</p>
                                      </TooltipContent>
                                    </Tooltip>
                                    <DropdownMenuContent align="end" className="border-border bg-secondary w-52">
                                      <DropdownMenuLabel className="text-muted-foreground text-xs">
                                        launch mode
                                      </DropdownMenuLabel>
                                      <DropdownMenuRadioGroup
                                        value={currentMode}
                                        onValueChange={(value) => {
                                          if (value !== currentMode) {
                                            onSetLaunchMode(process.id, process.name, value as LaunchMode, process.exe_path);
                                          }
                                        }}
                                      >
                                        <DropdownMenuRadioItem value="off" className="cursor-pointer">
                                          off
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="always" className="text-emerald-400 cursor-pointer">
                                          always on
                                        </DropdownMenuRadioItem>
                                        <DropdownMenuRadioItem value="scheduled" className="text-blue-400 cursor-pointer">
                                          scheduled
                                        </DropdownMenuRadioItem>
                                      </DropdownMenuRadioGroup>
                                      <DropdownMenuItem
                                        onClick={() => onConfigureSchedule?.(process)}
                                        className="text-blue-400 focus:bg-blue-950/30 focus:text-blue-300 cursor-pointer pl-8"
                                      >
                                        <Settings2 className="mr-2 h-3.5 w-3.5" />
                                        configure schedule
                                      </DropdownMenuItem>
                                      <DropdownMenuSeparator className="bg-accent" />
                                      <DropdownMenuItem
                                        onClick={() => onEditProcess(process)}
                                        className="cursor-pointer"
                                      >
                                        <Pencil className="mr-2 h-3.5 w-3.5" />
                                        edit process
                                      </DropdownMenuItem>
                                      {onDuplicateProcess && (
                                        <DropdownMenuItem
                                          onClick={() => onDuplicateProcess(process)}
                                          className="cursor-pointer"
                                        >
                                          <Copy className="mr-2 h-3.5 w-3.5" />
                                          duplicate process
                                        </DropdownMenuItem>
                                      )}
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onRestartProcess(process.id, process.name)}
                                        aria-label={`restart ${process.name}`}
                                        className="bg-card border border-border text-foreground disabled:cursor-not-allowed disabled:opacity-50 h-8 w-8 p-0"
                                        disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                      >
                                        <RotateCcw className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>restart process</p>
                                    </TooltipContent>
                                  </Tooltip>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onKillProcess(process.id, process.name)}
                                        aria-label={`kill ${process.name}`}
                                        className="bg-card border border-border text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50 h-8 w-8 p-0"
                                        disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                      >
                                        <Square className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>kill process</p>
                                    </TooltipContent>
                                  </Tooltip>
                                    </>
                                  )}
                                </div>
                              </>
                            );
                          })()}
                        </div>
                    ))}
                  </div>
                  {/* add process Button — admin-only write action */}
                  {isSiteAdmin && (
                    <div className="flex justify-center pt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onCreateProcess}
                        className="bg-card border border-border text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        add process
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                  <p className="mb-4 text-sm">No processes configured for this machine</p>
                  {isSiteAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={onCreateProcess}
                      className="bg-card border border-border text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      add process
                    </Button>
                  )}
                </div>
              )}
            </div>
            </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
