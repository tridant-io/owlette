/**
 * Grid of machine cards — status, sparkline metrics, expandable process list
 * with controls. Always used on mobile; toggleable with list view on desktop.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MachineContextMenu } from '@/components/MachineContextMenu';
import { MachineStatusPill } from '@/components/MachineStatusPill';
import { useDemoContext } from '@/contexts/DemoContext';
import { SparklineChart } from '@/components/charts';
import { ChevronDown, ChevronUp, Pencil, Copy, Square, Plus, Clock, AlertTriangle, X, RotateCcw, Settings2, BellOff, Monitor } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { formatTemperature, getTemperatureColorClass } from '@/lib/temperatureUtils';
import { getUsageColorClass } from '@/lib/usageColorUtils';
import { formatHeartbeatTime, getDisplayTimezone } from '@/lib/timeUtils';
import { formatThroughput } from '@/lib/networkUtils';
import { DISK_IO_COLORS, formatDiskIO } from '@/lib/diskIOUtils';
import { useAllSparklineData } from '@/hooks/useSparklineData';
import { useDevicePrefs, type DeviceKind } from '@/hooks/useDevicePrefs';
import { useDisplayState } from '@/hooks/useDisplayState';
import { DisplayCanvas } from '@/components/charts/DisplayCanvas';
import { resolveDevice, shouldShowDeviceDropdown } from '@/lib/deviceResolvers';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Machine, Process, LaunchMode, ScheduleBlock } from '@/hooks/useFirestore';
import type { MetricType } from '@/components/charts';

interface MachineCardViewProps {
  machines: Machine[];
  statsExpanded: boolean;
  processesExpanded: boolean;
  displaysExpanded?: boolean;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
  onToggleDisplays?: () => void;
  currentSiteId: string;
  siteTimezone?: string;
  siteTimeFormat?: '12h' | '24h';
  onEditProcess: (machineId: string, process: Process) => void;
  onDuplicateProcess?: (machineId: string, process: Process) => void;
  onCreateProcess: (machineId: string) => void;
  onKillProcess: (machineId: string, processId: string, processName: string) => void;
  onRestartProcess: (machineId: string, processId: string, processName: string) => void;
  onSetLaunchMode: (machineId: string, processId: string, processName: string, mode: LaunchMode, exePath: string, schedules?: ScheduleBlock[] | null) => void;
  onConfigureSchedule?: (machineId: string, process: Process) => void;
  onRemoveMachine: (machineId: string, machineName: string, isOnline: boolean) => void;
  onMetricClick?: (machineId: string, metricType: MetricType) => void;
  onRestart?: (machineId: string) => Promise<void>;
  onShutdown?: (machineId: string) => Promise<void>;
  onCancelRestart?: (machineId: string) => Promise<void>;
  onDismissRestartPending?: (machineId: string, processName: string) => Promise<void>;
  onScreenshot?: (machineId: string) => void;
  onLiveView?: (machineId: string) => void;
  onSwoop?: (machineId: string) => void;
}

/** Split out of the map so it can use hooks. */
interface MachineCardProps {
  machine: Machine;
  statsExpanded: boolean;
  processesExpanded: boolean;
  displaysExpanded?: boolean;
  currentSiteId: string;
  siteTimezone: string;
  siteTimeFormat: '12h' | '24h';
  userPreferences: { temperatureUnit: 'C' | 'F' };
  isSiteAdmin: boolean;
  cardPref: { cpu?: string; disk?: string; gpu?: string; nic?: string };
  onSetCardPref: (kind: DeviceKind, id: string | null) => void;
  onToggleStats: () => void;
  onToggleProcesses: () => void;
  onToggleDisplays?: () => void;
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
  onDismissRestartPending?: (processName: string) => Promise<void>;
  onScreenshot?: () => void;
  onLiveView?: () => void;
  onSwoop?: () => void;
}

function MachineCard({
  machine,
  statsExpanded,
  processesExpanded,
  displaysExpanded,
  currentSiteId,
  siteTimezone,
  siteTimeFormat,
  userPreferences,
  isSiteAdmin,
  cardPref,
  onSetCardPref,
  onToggleStats,
  onToggleProcesses,
  onToggleDisplays,
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
  onDismissRestartPending,
  onScreenshot,
  onLiveView,
  onSwoop,
}: MachineCardProps) {
  const isDemo = !!useDemoContext();
  const { userPreferences: fullPrefs } = useAuth();
  const isMuted = fullPrefs.mutedMachines.includes(machine.machineId);

  const sparklineData = useAllSparklineData(currentSiteId, machine.machineId);

  // Always subscribed so the COLLAPSED summary can show resolutions instead
  // of "no data". No assigned-layout sub — the drift dot reads the
  // heartbeat-published `metrics.displayDriftCount`, not a client-side diff.
  const { profile: displayProfile } = useDisplayState(
    currentSiteId,
    machine.machineId,
    { enabled: true, subscribeAssigned: false }
  );
  const displayMonitors = displayProfile?.monitors ?? [];
  const displayDriftCount = machine.metrics?.displayDriftCount ?? 0;
  // Parent preference is the source of truth; default collapsed on first render.
  const effectiveDisplaysExpanded = displaysExpanded ?? false;

  // Display tz is per-machine, from the user's `timeDisplayMode` preference.
  const displayTz = getDisplayTimezone(
    fullPrefs.timeDisplayMode || 'machine',
    fullPrefs.timezone,
    machine.machineTimezone,
    siteTimezone
  );
  const heartbeat = formatHeartbeatTime(machine.lastHeartbeat, displayTz, siteTimeFormat);

  // Resolve per-card device selection (user pref → primary → first).
  const primary = machine.metrics?.primary;
  const cpuDevice = resolveDevice(machine.devices?.cpus, cardPref.cpu, primary?.cpu);
  const diskDevice = resolveDevice(machine.devices?.disks, cardPref.disk, primary?.disk);
  const gpuDevice = resolveDevice(machine.devices?.gpus, cardPref.gpu, primary?.gpu);
  const nicDevice = resolveDevice(machine.devices?.nics, cardPref.nic, primary?.nic);

  const showCpuDropdown = shouldShowDeviceDropdown(machine.devices?.cpus);
  const showDiskDropdown = shouldShowDeviceDropdown(machine.devices?.disks);
  const showGpuDropdown = shouldShowDeviceDropdown(machine.devices?.gpus);
  const showNicDropdown = shouldShowDeviceDropdown(machine.devices?.nics);

  // v2 agents no longer send total_gb; recover it from usedGb / (percent/100).
  const memory = machine.metrics?.memory;
  const memoryTotalGb =
    memory && memory.usedGb != null && memory.percent != null && memory.percent > 0
      ? memory.usedGb / (memory.percent / 100)
      : null;

  // Inline so they close over machine + resolved device state.
  const renderDeviceSelect = (
    kind: DeviceKind,
    devices: { id: string }[],
    currentId: string | undefined,
    labelFor: (id: string) => string
  ) => (
    <Select
      value={currentId ?? 'auto'}
      onValueChange={(v) => onSetCardPref(kind, v === 'auto' ? null : v)}
    >
      <SelectTrigger
        size="sm"
        className="h-5 px-1.5 py-0 text-xs border-0 bg-transparent shadow-none gap-1 text-muted-foreground hover:text-foreground focus-visible:ring-0"
        onClick={(e) => e.stopPropagation()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="auto">auto (most active)</SelectItem>
        {devices.map((d) => (
          <SelectItem key={d.id} value={d.id}>{labelFor(d.id)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <Card data-testid="machine-card" className="border-border/60 bg-card-sunken py-0 gap-0">
      <CardHeader className="py-3 px-4 gap-0 bg-card-header rounded-t-xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            {/* Display icon — quick access to the display panel, mirrors the
                list view's per-row Monitor button (drift/breaker dots included). */}
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
            <div className="flex flex-col min-w-0">
              <CardTitle className="text-xl font-semibold text-white select-text flex items-center gap-1.5">
                {machine.machineId}
                {isMuted && <span title="alerts muted"><BellOff className="h-3.5 w-3.5 text-muted-foreground" /></span>}
              </CardTitle>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={`text-xs tabular-nums flex items-center gap-1 select-none cursor-help ${heartbeat.isStale ? 'text-red-400' : 'text-foreground/80'}`}
                >
                  <Clock className="h-3 w-3" />
                  {heartbeat.display}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{heartbeat.tooltip}</p>
              </TooltipContent>
            </Tooltip>
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
                swoopCapable={machine.capabilities?.swoop === 1}
                onSwoop={onSwoop}
                onViewDisplays={onMetricClick ? () => onMetricClick('display') : undefined}
                rebootSchedule={machine.rebootSchedule}
              />
            )}
          </div>
        </div>
      </CardHeader>
      {/* Restart Pending Banner */}
      {machine.rebootPending?.active && (
        <div className="mx-4 mb-2 p-3 rounded-lg border border-amber-600/30 bg-amber-950/20">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
              <span className="text-sm text-amber-300 truncate">
                restart pending: {machine.rebootPending.reason || 'process crashed'}
              </span>
            </div>
            {isSiteAdmin && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="reboot-pending-approve"
                  className="h-7 px-2.5 text-xs bg-amber-600 hover:bg-amber-700 text-white cursor-pointer"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (onRestart) {
                      try { await onRestart(); } catch {}
                    }
                  }}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="reboot-pending-dismiss"
                  className="h-7 px-2.5 text-xs text-muted-foreground hover:text-white hover:bg-accent cursor-pointer"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (onDismissRestartPending && machine.rebootPending?.processName) {
                      try { await onDismissRestartPending(machine.rebootPending.processName); } catch {}
                    }
                  }}
                >
                  <X className="h-3 w-3 mr-1" />
                  dismiss
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {machine.metrics && (
        <Collapsible open={statsExpanded} onOpenChange={onToggleStats}>
          {!statsExpanded && (
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full border-t border-border/50 rounded-none cursor-pointer px-4 py-2.5 h-auto">
                <div className="flex items-center gap-2 w-full select-none">
                  <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  {/* fixed five cells, absent metrics included: the same metric
                      lands at the same x on every card, so the dashboard reads
                      as columns rather than five different ragged rows */}
                  <div className="grid grid-cols-5 gap-x-2 flex-1 min-w-0 text-sm text-muted-foreground/70">
                    <span className="min-w-0 truncate tabular-nums">
                      {cpuDevice && cpuDevice.percent != null && (
                        <>cpu <span className="text-foreground font-medium">{cpuDevice.percent}%</span>
                          {cpuDevice.temperature != null && (
                            <span className={`ml-1 ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                              {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <span className="min-w-0 truncate tabular-nums">
                      {memory?.percent != null && (
                        <>mem <span className="text-foreground font-medium">{memory.percent}%</span></>
                      )}
                    </span>
                    <span className="min-w-0 truncate tabular-nums">
                      {diskDevice && diskDevice.percent != null && (() => {
                        const io = machine.metrics?.diskio?.[diskDevice.id];
                        return (
                          <>disk <span className="text-foreground font-medium">{diskDevice.percent}%</span>
                            {io && io.readBps > 0 && (
                              <span className="ml-1" style={{ color: DISK_IO_COLORS.read }}>
                                r {formatDiskIO(io.readBps)}
                              </span>
                            )}
                            {io && io.writeBps > 0 && (
                              <span className="ml-1" style={{ color: DISK_IO_COLORS.write }}>
                                w {formatDiskIO(io.writeBps)}
                              </span>
                            )}
                          </>
                        );
                      })()}
                    </span>
                    <span className="min-w-0 truncate tabular-nums">
                      {gpuDevice && gpuDevice.usagePercent != null && (
                        <>gpu <span className="text-foreground font-medium">{gpuDevice.usagePercent}%</span>
                          {gpuDevice.temperature != null && (
                            <span className={`ml-1 ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                              {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                    <span className="min-w-0 truncate tabular-nums">
                      {nicDevice && nicDevice.txBps != null && nicDevice.rxBps != null && (
                        <>net <span className="text-orange-400">{'↑'}{formatThroughput(nicDevice.txBps)}</span>
                          <span className="ml-1 text-green-400">{'↓'}{formatThroughput(nicDevice.rxBps)}</span>
                          {(machine.metrics.network?.packetLossPct ?? 0) > 0 && (
                            <span className="ml-1 text-red-400">{machine.metrics.network?.packetLossPct}% loss</span>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                </div>
              </Button>
            </CollapsibleTrigger>
          )}
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        <CollapsibleTrigger asChild>
          <div className="border-t border-border/50 relative cursor-pointer group">
            <div className="absolute inset-0 bg-gradient-to-b from-[var(--surface-hover)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative flex items-center px-4 py-1.5 select-none">
              <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
            </div>
          </div>
        </CollapsibleTrigger>
        <CardContent className="select-none pt-0 pb-4">
          {/* Section enclosure: one surface holding the metric rows, separated by
              hairline dividers instead of dark gaps. */}
          <div className="overflow-hidden rounded-lg border border-border/30 bg-card divide-y divide-border/60">
          {/* CPU Metric */}
          {cpuDevice && cpuDevice.percent != null && (
            <div
              className={`relative overflow-hidden cursor-pointer transition-colors group after:pointer-events-none after:absolute after:inset-0 after:content-[''] after:transition-colors hover:after:bg-secondary/25`}
              onClick={onMetricClick ? () => onMetricClick('cpu') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.cpu} color="cpu" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(cpuDevice.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">cpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={cpuDevice.model || cpuDevice.id}>
                    {cpuDevice.model || cpuDevice.id}
                  </span>
                  {showCpuDropdown && machine.devices?.cpus && (
                    renderDeviceSelect('cpu', machine.devices.cpus, cardPref.cpu, (id) => {
                      const d = machine.devices?.cpus.find(x => x.id === id);
                      return d?.model || id;
                    })
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{cpuDevice.percent}%</span>
                  {cpuDevice.temperature != null && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(cpuDevice.temperature)}`}>
                      {formatTemperature(cpuDevice.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Memory Metric */}
          {memory?.percent != null && (
            <div
              className={`relative overflow-hidden cursor-pointer transition-colors group after:pointer-events-none after:absolute after:inset-0 after:content-[''] after:transition-colors hover:after:bg-secondary/25`}
              onClick={onMetricClick ? () => onMetricClick('memory') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.memory} color="memory" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(memory.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">ram</span>
                  {memory.usedGb != null && memoryTotalGb != null && (
                    <span className="text-xs text-muted-foreground hidden sm:block">
                      {memory.usedGb.toFixed(1)} / {memoryTotalGb.toFixed(1)} GB
                    </span>
                  )}
                </div>
                <span className="text-lg font-bold text-white tabular-nums">{memory.percent}%</span>
              </div>
            </div>
          )}

          {/* Disk Metric */}
          {diskDevice && diskDevice.percent != null && (
            <div
              className={`relative overflow-hidden cursor-pointer transition-colors group after:pointer-events-none after:absolute after:inset-0 after:content-[''] after:transition-colors hover:after:bg-secondary/25`}
              onClick={onMetricClick ? () => onMetricClick('disk') : undefined}
            >
              {/* Sparkline background */}
              <div className="absolute inset-0 opacity-80">
                <SparklineChart data={sparklineData.disk} color="disk" height={52} loading={sparklineData.loading} />
              </div>
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(diskDevice.percent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-muted-foreground">disk</span>
                  <span className="text-xs text-muted-foreground hidden sm:block">
                    {diskDevice.id}
                    {diskDevice.usedGb != null && diskDevice.totalGb != null && (
                      <> &nbsp;{diskDevice.usedGb.toFixed(1)} / {diskDevice.totalGb.toFixed(1)} GB</>
                    )}
                  </span>
                  {showDiskDropdown && machine.devices?.disks && (
                    renderDeviceSelect('disk', machine.devices.disks, cardPref.disk, (id) => id)
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {(() => {
                    const io = machine.metrics?.diskio?.[diskDevice.id];
                    if (!io || (io.readBps === 0 && io.writeBps === 0)) return null;
                    return (
                      <div className="flex gap-1 text-xs font-medium leading-tight">
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
                  <span className="text-lg font-bold text-white tabular-nums">{diskDevice.percent}%</span>
                </div>
              </div>
            </div>
          )}

          {/* GPU Metric */}
          {gpuDevice && gpuDevice.usagePercent != null && (
            <div
              className={`relative overflow-hidden cursor-pointer transition-colors group after:pointer-events-none after:absolute after:inset-0 after:content-[''] after:transition-colors hover:after:bg-secondary/25`}
              onClick={onMetricClick ? () => onMetricClick('gpu') : undefined}
            >
              {/* Sparkline background */}
              {sparklineData.gpu.length > 0 && (
                <div className="absolute inset-0 opacity-80">
                  <SparklineChart data={sparklineData.gpu} color="gpu" height={52} loading={sparklineData.loading} />
                </div>
              )}
              {/* Left accent bar - color based on usage */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(gpuDevice.usagePercent)}`} />
              {/* Content */}
              <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-muted-foreground">gpu</span>
                  <span className="text-xs text-muted-foreground truncate hidden sm:block" title={gpuDevice.name || gpuDevice.id}>
                    {gpuDevice.name || gpuDevice.id}
                  </span>
                  {showGpuDropdown && machine.devices?.gpus && (
                    renderDeviceSelect('gpu', machine.devices.gpus, cardPref.gpu, (id) => {
                      const d = machine.devices?.gpus.find(x => x.id === id);
                      return d?.name || id;
                    })
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-lg font-bold text-white tabular-nums">{gpuDevice.usagePercent}%</span>
                  {gpuDevice.vramUsedGb != null && gpuDevice.vramTotalGb != null && gpuDevice.vramTotalGb > 0 && (
                    <span className="text-xs text-muted-foreground hidden md:block">
                      {gpuDevice.vramUsedGb.toFixed(1)}/{gpuDevice.vramTotalGb.toFixed(1)}GB
                    </span>
                  )}
                  {gpuDevice.temperature != null && (
                    <span className={`text-sm font-medium ${getTemperatureColorClass(gpuDevice.temperature)}`}>
                      {formatTemperature(gpuDevice.temperature, userPreferences.temperatureUnit)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Network Metric */}
          {nicDevice && nicDevice.txBps != null && nicDevice.rxBps != null && (() => {
            const maxUtil = Math.max(nicDevice.txUtil ?? 0, nicDevice.rxUtil ?? 0);
            return (
              <div
                className={`relative overflow-hidden cursor-pointer transition-colors group after:pointer-events-none after:absolute after:inset-0 after:content-[''] after:transition-colors hover:after:bg-secondary/25`}
                onClick={onMetricClick ? () => onMetricClick(`${nicDevice.id}_tx_util` as MetricType) : undefined}
              >
                <div className={`absolute left-0 top-0 bottom-0 w-1 ${getUsageColorClass(maxUtil)}`} />
                <div className="relative z-10 flex items-center justify-between px-3 py-2.5 pl-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-muted-foreground">network</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block" title={nicDevice.linkSpeedMbps ? `${nicDevice.id} (${nicDevice.linkSpeedMbps} Mbps)` : nicDevice.id}>
                      {nicDevice.id}
                    </span>
                    {showNicDropdown && machine.devices?.nics && (
                      renderDeviceSelect('nic', machine.devices.nics, cardPref.nic, (id) => id)
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-xs font-medium text-orange-400">{'\u2191 '}{formatThroughput(nicDevice.txBps)}</span>
                    <span className="text-xs font-medium text-green-400">{'\u2193 '}{formatThroughput(nicDevice.rxBps)}</span>
                  </div>
                </div>
              </div>
            );
          })()}
          </div>
        </CardContent>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Displays Collapsible */}
      <Collapsible open={effectiveDisplaysExpanded} onOpenChange={onToggleDisplays}>
        {!effectiveDisplaysExpanded && (
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full border-t border-border/50 rounded-none cursor-pointer px-4 py-2.5 h-auto">
              <div className="flex items-center gap-2 w-full select-none">
                <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                {displayMonitors.length > 0 ? (
                  <div className="flex items-center gap-2.5 text-sm text-muted-foreground/70 overflow-hidden min-w-0">
                    <span className="tabular-nums flex-shrink-0">
                      <span className="text-foreground font-medium">{displayMonitors.length}</span> display{displayMonitors.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-border/60 flex-shrink-0">|</span>
                    <span className="truncate tabular-nums">
                      {displayMonitors.map((m, i) => {
                        const rotated = m.rotation === 90 || m.rotation === 270;
                        const w = rotated ? m.resolution.height : m.resolution.width;
                        const h = rotated ? m.resolution.width : m.resolution.height;
                        return (
                          <span key={m.id}>
                            {i > 0 && <span className="mx-1.5 text-border/60">·</span>}
                            <span className={m.primary ? 'text-foreground font-medium' : ''}>{w}x{h}</span>
                          </span>
                        );
                      })}
                    </span>
                    {displayDriftCount > 0 && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-amber-500 ml-2 flex-shrink-0"
                        role="img"
                        aria-label={`${displayDriftCount} display change${displayDriftCount === 1 ? '' : 's'} from assigned`}
                        title={`${displayDriftCount} display change${displayDriftCount === 1 ? '' : 's'} from assigned`}
                      />
                    )}
                    {machine.displayBreakerTripped && (
                      <span
                        className="inline-block w-2 h-2 rounded-full bg-destructive ml-1 flex-shrink-0"
                        role="img"
                        aria-label="auto-restore disabled — circuit breaker tripped"
                        title="auto-restore disabled — circuit breaker tripped"
                      />
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">displays: no data</span>
                )}
              </div>
            </Button>
          </CollapsibleTrigger>
        )}
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
          <CollapsibleTrigger asChild>
            <div className="border-t border-border/50 relative cursor-pointer group">
              <div className="absolute inset-0 bg-gradient-to-b from-[var(--surface-hover)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative flex items-center px-4 py-1.5 select-none">
                <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
              </div>
            </div>
          </CollapsibleTrigger>
          <div
            className={`px-6 pb-4 pt-2 ${onMetricClick ? 'cursor-pointer hover:bg-[var(--surface-hover)] transition-colors' : ''}`}
            onClick={onMetricClick ? (e) => { e.stopPropagation(); onMetricClick('display'); } : undefined}
          >
            {displayMonitors.length > 0 ? (
              /* One column below sm: the monitor list's nowrap rows (name +
                 resolution + primary star) demand ~200px of min-content each,
                 and a two-`fr` split doubles that demand into the card's
                 intrinsically-sized grid track — which is what pushed the
                 document past 390px. Stacked, the panes share one track and the
                 shared enclosure rounds top/bottom instead of left/right. */
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
                <div className="min-w-0 h-[160px] border border-border/30 bg-card border-b-0 sm:border-b rounded-t-lg sm:rounded-tr-none sm:rounded-bl-lg md:border-r-0 overflow-hidden">
                  <DisplayCanvas
                    monitors={displayMonitors}
                    mosaicGrids={displayProfile?.mosaicGrids}
                    labelMode="indexOnly"
                    className="h-[160px]"
                  />
                </div>
                <div className="h-[160px] border border-border/30 bg-card rounded-b-lg sm:rounded-bl-none sm:rounded-tr-lg overflow-hidden flex flex-col justify-center gap-1.5 px-3 text-xs text-muted-foreground">
                  {displayMonitors.map((m, i) => {
                    // Post-rotation dims, matching Windows and the canvas
                    // rect: a 4K panel at 270° reads 2160×3840.
                    const isPortrait = m.rotation === 90 || m.rotation === 270;
                    const effW = isPortrait ? m.resolution.height : m.resolution.width;
                    const effH = isPortrait ? m.resolution.width : m.resolution.height;
                    return (
                      <div key={m.id} className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-muted-foreground shrink-0">{i + 1}</span>
                        <span className="text-foreground font-medium truncate">{m.friendlyName || m.id}</span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">{effW}×{effH}</span>
                        {m.primary && <span className="text-amber-500 shrink-0" role="img" aria-label="primary">★</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground py-4 text-center">no display data reported</div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Expandable Process List */}
      {machine.processes && machine.processes.length > 0 && (
        <Collapsible open={processesExpanded} onOpenChange={onToggleProcesses}>
          {!processesExpanded && (
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="w-full border-t border-border/50 rounded-none cursor-pointer px-4 py-2.5 h-auto">
                <div className="flex items-center gap-2.5 w-full select-none overflow-hidden">
                  <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm flex-shrink-0 text-muted-foreground/70">
                    <span className="text-foreground font-medium">{machine.processes.length}</span> process{machine.processes.length > 1 ? 'es' : ''}
                  </span>
                  <span className="text-border/60 flex-shrink-0">|</span>
                  <div className="flex items-center overflow-hidden min-w-0">
                    {machine.processes.map((proc, i) => (
                      <span key={proc.id} className="flex items-center flex-shrink-0">
                        {i > 0 && <span className="mx-1.5 text-border/60">·</span>}
                        <span className={`mr-1.5 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                          !machine.online ? 'bg-muted-foreground/40' :
                          proc.status === 'RUNNING' ? 'bg-green-500' :
                          proc.status === 'INACTIVE' ? 'bg-slate-500' :
                          proc.status === 'LAUNCH_FAILED' || proc.status === 'STOPPED' || proc.status === 'KILLED' ? 'bg-red-500' :
                          'bg-yellow-500'
                        }`} />
                        <span className="text-sm text-muted-foreground truncate max-w-[160px]" title={proc.name}>{proc.name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </Button>
            </CollapsibleTrigger>
          )}
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
            <CollapsibleTrigger asChild>
              <div className="border-t border-border/50 relative cursor-pointer group">
                <div className="absolute inset-0 bg-gradient-to-b from-[var(--surface-hover)] to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="relative flex items-center px-4 py-2 select-none">
                  <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
                </div>
              </div>
            </CollapsibleTrigger>
            <div className="relative px-6 pb-2 pt-0 md:pb-4 md:pt-0">
              <div className="overflow-hidden rounded-lg border border-border/30 bg-card divide-y divide-border/60">
                {machine.processes.map((process) => (
                  /* Below sm the control rail stacks under the process info
                     instead of wrap-packing beside it — see MachineListView. */
                  <div key={process.id} className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center sm:justify-between gap-y-2 px-3 py-2.5 pl-4">
                        {/* min-w-40 (not 0): with flex-wrap, line packing uses
                            flex-basis clamped by min-width — at min-w-0 the
                            flex-1 name contributes nothing, never wraps, and
                            gets squeezed to 0px by the shrink-0 action cluster */}
                        <div className="flex-1 min-w-40 flex items-center gap-2">
                          <span className="text-sm md:text-base text-white font-medium truncate select-text">{process.name}</span>
                          <Badge className={`text-xs flex-shrink-0 select-none ${!machine.online ? 'bg-muted text-muted-foreground' : process.status === 'RUNNING' ? 'bg-green-600' : process.status === 'INACTIVE' ? 'bg-slate-600 text-slate-200' : process.status === 'LAUNCH_FAILED' || process.status === 'STOPPED' || process.status === 'KILLED' ? 'bg-red-600 text-white' : 'bg-yellow-600'}`}>
                            {(!machine.online ? 'unknown' : process.status === 'LAUNCH_FAILED' ? 'failed' : process.status).toLowerCase()}
                          </Badge>
                        </div>
                        {/* grow (not shrink-0): the cluster has to own the row's
                            spare width so the run controls can sit hard right,
                            including on the wrapped line where the name takes
                            its own row */}
                        <div className="flex grow items-center gap-2 md:gap-3 sm:ml-2 md:ml-4">
                          {(() => {
                            const currentMode = (process._optimisticLaunchMode ?? process.launch_mode ?? (process.autolaunch ? 'always' : 'off')) as LaunchMode;
                            const modeLabels = { off: 'off', always: 'always on', scheduled: 'scheduled' } as const;
                            // Non-admins: static pill, since the toggle would 403.
                            if (!isSiteAdmin) {
                              const readOnlyColor = currentMode === 'always'
                                ? 'text-emerald-400 border-emerald-600/40'
                                : currentMode === 'scheduled'
                                ? 'text-blue-400 border-blue-600/40'
                                : 'text-muted-foreground border-border/50';
                              return (
                                <div className="hidden md:flex items-center h-8">
                                  <span className={`flex items-center px-3 text-sm font-medium rounded-md border bg-card ${readOnlyColor}`}>
                                    {modeLabels[currentMode]}
                                  </span>
                                </div>
                              );
                            }
                            return (
                              <div className="hidden md:flex items-stretch rounded-md overflow-hidden border border-border/50 h-8">
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
                                            {/* Icon-only: the label lives in the
                                                tooltip portal, which does not
                                                surface as an accessible name
                                                until the pointer hovers, so
                                                role+name can never resolve it. */}
                                            <button
                                              onClick={() => onConfigureSchedule?.(process)}
                                              data-testid="process-row-configure-schedule"
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
                            );
                          })()}
                          {isSiteAdmin && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => onEditProcess(process)}
                                className="bg-card border border-border/50 text-foreground p-2"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              {onDuplicateProcess && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => onDuplicateProcess(process)}
                                      aria-label={`duplicate ${process.name}`}
                                      className="bg-card border border-border/50 text-foreground p-2"
                                    >
                                      <Copy className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    <p>duplicate process</p>
                                  </TooltipContent>
                                </Tooltip>
                              )}
                              {/* run controls float right, away from the
                                  configuration actions — a mis-click here
                                  interrupts a live process */}
                              <div className="ml-auto flex items-center gap-2 md:gap-3">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => onRestartProcess(process.id, process.name)}
                                    aria-label={`restart ${process.name}`}
                                    className="bg-card border border-border/50 text-foreground disabled:cursor-not-allowed disabled:opacity-50 p-2"
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
                                    className="bg-card border border-border/50 text-red-400 hover:bg-red-950/50 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-50 p-2"
                                    disabled={process.status !== 'RUNNING' && process.status !== 'LAUNCHING' && process.status !== 'STALLED'}
                                  >
                                    <Square className="h-3 w-3" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>kill process</p>
                                </TooltipContent>
                              </Tooltip>
                              </div>
                            </>
                          )}
                        </div>
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
                      className="bg-card border border-border/50 text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      add process
                    </Button>
                  </div>
                )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* add process button for machines with no processes — admin-only */}
      {isSiteAdmin && (!machine.processes || machine.processes.length === 0) && (
        <div className="border-t border-border/50 flex justify-center p-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCreateProcess}
            className="bg-card border border-border/50 text-accent-cyan hover:bg-accent-cyan/15 hover:text-accent-cyan"
          >
            <Plus className="h-3 w-3 mr-1" />
            add process
          </Button>
        </div>
      )}
    </Card>
  );
}

export function MachineCardView({
  machines,
  statsExpanded,
  processesExpanded,
  displaysExpanded,
  onToggleStats,
  onToggleProcesses,
  onToggleDisplays,
  currentSiteId,
  siteTimezone = 'UTC',
  siteTimeFormat = '12h',
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
  onDismissRestartPending,
  onScreenshot,
  onLiveView,
  onSwoop,
}: MachineCardViewProps) {
  const { userPreferences, isSiteAdmin } = useAuth();
  const canSiteAdmin = isSiteAdmin(currentSiteId);
  const { prefs, setCardPref } = useDevicePrefs();

  return (
    // `machines-grid` hooks the globals.css slide-perf rule: under
    // data-slide-pausing="true" each card gets `content-visibility: auto` so
    // offscreen cards don't compete with the slide for frame budget.
    //
    // `grid-cols-1` is load-bearing below md: an implicit `auto` track sizes to
    // min-content, so any nowrap label or nested fr split drags it past the
    // viewport and scrolls the page sideways. minmax(0, 1fr) pins it.
    <div className="machines-grid grid grid-cols-1 gap-4 md:grid-cols-2">
      {machines.map((machine) => (
        <MachineCard
          key={machine.machineId}
          machine={machine}
          statsExpanded={statsExpanded}
          processesExpanded={processesExpanded}
          displaysExpanded={displaysExpanded}
          currentSiteId={currentSiteId}
          siteTimezone={siteTimezone}
          siteTimeFormat={siteTimeFormat}
          userPreferences={userPreferences}
          isSiteAdmin={canSiteAdmin}
          cardPref={prefs.cardView[machine.machineId] ?? {}}
          onSetCardPref={(kind, id) => setCardPref(machine.machineId, kind, id)}
          onToggleStats={onToggleStats}
          onToggleProcesses={onToggleProcesses}
          onToggleDisplays={onToggleDisplays}
          onEditProcess={(process) => onEditProcess(machine.machineId, process)}
          onDuplicateProcess={onDuplicateProcess ? (process) => onDuplicateProcess(machine.machineId, process) : undefined}
          onCreateProcess={() => onCreateProcess(machine.machineId)}
          onKillProcess={(processId, processName) => onKillProcess(machine.machineId, processId, processName)}
          onRestartProcess={(processId, processName) => onRestartProcess(machine.machineId, processId, processName)}
          onSetLaunchMode={(processId, processName, mode, exePath, schedules) =>
            onSetLaunchMode(machine.machineId, processId, processName, mode, exePath, schedules)
          }
          onConfigureSchedule={onConfigureSchedule ? (process) => onConfigureSchedule(machine.machineId, process) : undefined}
          onRemoveMachine={() => onRemoveMachine(machine.machineId, machine.machineId, machine.online)}
          onMetricClick={onMetricClick ? (metricType) => onMetricClick(machine.machineId, metricType) : undefined}
          onRestart={onRestart ? () => onRestart(machine.machineId) : undefined}
          onShutdown={onShutdown ? () => onShutdown(machine.machineId) : undefined}
          onCancelRestart={onCancelRestart ? () => onCancelRestart(machine.machineId) : undefined}
          onDismissRestartPending={onDismissRestartPending ? (processName) => onDismissRestartPending(machine.machineId, processName) : undefined}
          onScreenshot={onScreenshot ? () => onScreenshot(machine.machineId) : undefined}
          onLiveView={onLiveView ? () => onLiveView(machine.machineId) : undefined}
          onSwoop={onSwoop ? () => onSwoop(machine.machineId) : undefined}
        />
      ))}
    </div>
  );
}
