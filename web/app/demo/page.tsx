'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { LayoutGrid, List, Monitor, Cog, ChevronsUpDown, ChevronsDownUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody } from '@/components/ui/table';
import { PageHeader } from '@/components/PageHeader';
import { MetricsDetailPanel, type MetricType } from '@/components/charts';
import { DisplayLayoutPanel } from '@/components/charts/DisplayLayoutPanel';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow, MemoizedTableHeader as ListViewTableHeader } from '@/app/dashboard/components/MachineListView';
import { AddMachineButton } from '@/app/dashboard/components/AddMachineButton';
import { useSlidePanel } from '@/hooks/useSlidePanel';
import { DemoContext } from '@/contexts/DemoContext';
import {
  DEMO_SITE_ID,
  DEMO_SITE,
  getDemoMachines,
  getDemoSparklineData,
  getDemoHistoricalData,
  getDemoDisplayState,
} from '@/lib/demo-data';

type ViewType = 'card' | 'list';

interface DetailPanelState {
  machineId: string;
  machineName: string;
  metric: MetricType;
}

// No-op async handler for required Promise-returning props
const noopAsync = async () => {};
// No-op sync handler
const noop = () => {};

export default function DemoPage() {
  // `getDemoMachines()` uses Math.random() + Date.now(), so SSR and client
  // render differ; React 19 throws away the SSR DOM on mismatch and re-renders,
  // which re-fires the wrapper's CSS fade-in. Gating on a post-mount flag makes
  // SSR and the first CSR render identical (an empty shell) so the animation
  // plays once. The set-state-in-effect rule flags the cascade, but here it IS
  // the point: one mount → render boundary, not a value-syncing loop.
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const machines = useMemo(() => getDemoMachines(), []);
  const [viewType, setViewType] = useState<ViewType>('list');
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState | null>(null);

  // Same hook the dashboard uses, so demo and prod feel identical when
  // expanding / collapsing a panel.
  const {
    wrapperRef: slideWrapperRef,
    contentRef: slideContentRef,
    held: heldDetailPanel,
    slideAnimating,
  } = useSlidePanel<DetailPanelState>({
    value: detailPanel,
    reanimateKey: (p) => p.machineId,
    reflowKey: (p) => (p.metric === 'display' ? 'display' : 'metric'),
  });

  const [expandedMachineIds, setExpandedMachineIds] = useState<Set<string>>(
    () => new Set()
  );

  const allExpanded = expandedMachineIds.size === machines.length;

  const toggleAllProcesses = useCallback(() => {
    setExpandedMachineIds(prev => {
      if (prev.size === machines.length) {
        setStatsExpanded(false);
        return new Set();
      }
      setStatsExpanded(true);
      return new Set(machines.map(m => m.machineId));
    });
  }, [machines]);

  const toggleMachineExpanded = useCallback((machineId: string) => {
    setExpandedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const toggleStats = useCallback(() => setStatsExpanded(v => !v), []);

  const handleMetricClick = useCallback((machineId: string, metric: MetricType) => {
    const machine = machines.find(m => m.machineId === machineId);
    setDetailPanel({
      machineId,
      machineName: machine?.machineId || machineId,
      metric,
    });
  }, [machines]);

  // Switch the open metrics panel to another machine, keeping the current metric.
  const handleSwitchMachine = useCallback((machineId: string) => {
    setDetailPanel(prev => {
      if (!prev || prev.metric === 'display') return prev;
      const machine = machines.find(m => m.machineId === machineId);
      return { machineId, machineName: machine?.machineId || machineId, metric: prev.metric };
    });
  }, [machines]);

  const sites = useMemo(() => [DEMO_SITE], []);
  const onlineMachines = machines.filter(m => m.online).length;
  const totalProcesses = machines.reduce((acc, m) => {
    return acc + (m.metrics?.processes ? Object.keys(m.metrics.processes).length : 0);
  }, 0);

  const demoContextValue = useMemo(() => ({
    isDemo: true as const,
    getSparklineData: getDemoSparklineData,
    getHistoricalData: getDemoHistoricalData,
    getDisplayState: getDemoDisplayState,
  }), []);

  return (
    <DemoContext.Provider value={demoContextValue}>
      <div className="relative min-h-screen pb-24">
        {/* Header */}
        <PageHeader
          currentPage="dashboard"
          sites={sites}
          currentSiteId={DEMO_SITE_ID}
          onSiteChange={noop}
          onManageSites={noop}
          disableNav
        />

        {/* Demo banner */}
        <div className="bg-accent-cyan/10 border-b border-accent-cyan/20">
          <div className="mx-auto max-w-screen-2xl px-3 md:px-4 py-2">
            <p className="text-sm text-muted-foreground">
              you&apos;re viewing a demo with sample data
            </p>
          </div>
        </div>

        {/* Main content — gated on `mounted` so SSR returns an empty shell
            (no random-data hydration mismatch, no double fade-in). */}
        <main className="relative z-10 mx-auto max-w-screen-2xl p-3 md:p-4">
         {mounted && (<>
          {/* Welcome + stats */}
          <div className="mt-3 md:mt-2 mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex-1">
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-1">
                welcome to owlette!
              </h2>
              <p className="text-sm md:text-base text-muted-foreground">
                keeping your pixels in good hands
              </p>
            </div>

            {/* Quick stats — mirrors the dashboard, including the narrow-width
                wrap so the row can never widen the page. */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3 sm:gap-x-6 md:gap-8">
              <div className="flex items-center gap-2.5">
                <div className={`rounded-md p-1.5 ${onlineMachines > 0 ? 'bg-success-surface text-success' : 'bg-muted text-muted-foreground'}`}>
                  <Monitor className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className={`text-xl font-bold ${onlineMachines > 0 ? 'text-success' : 'text-foreground'}`}>{onlineMachines}</span>
                    <span className="text-xs text-muted-foreground">/ {machines.length}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">online</p>
                </div>
              </div>

              <div className="h-8 w-px bg-border" />

              <div className="flex items-center gap-2.5">
                <div className="rounded-md p-1.5 bg-muted text-muted-foreground">
                  <Cog className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-baseline gap-0.5">
                    <span className="text-xl font-bold text-foreground">{totalProcesses}</span>
                    <span className="text-xs text-muted-foreground">managed</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-tight">processes</p>
                </div>
              </div>
            </div>
          </div>

          {/* Detail Panel — animates open / close via `useSlidePanel`,
              mirroring the dashboard. The held copy stays mounted during
              the close transition so the height interpolation has visual
              content to slide over. `display` renders the topology
              panel; everything else renders the metrics panel. */}
          <div
            ref={slideWrapperRef}
            className="overflow-hidden transition-[height] duration-200 ease-out"
            style={{ contain: 'layout paint' }}
            aria-hidden={!detailPanel}
          >
            <div ref={slideContentRef} className="pb-6" style={{ contain: 'layout paint' }}>
              {heldDetailPanel && (
                heldDetailPanel.metric === 'display' ? (
                  <DisplayLayoutPanel
                    machineId={heldDetailPanel.machineId}
                    machineName={heldDetailPanel.machineName}
                    siteId={DEMO_SITE_ID}
                    onClose={() => setDetailPanel(null)}
                  />
                ) : (
                  <MetricsDetailPanel
                    machineId={heldDetailPanel.machineId}
                    machineName={heldDetailPanel.machineName}
                    siteId={DEMO_SITE_ID}
                    initialMetric={heldDetailPanel.metric}
                    onClose={() => setDetailPanel(null)}
                    machines={machines}
                    onSwitchMachine={handleSwitchMachine}
                  />
                )
              )}
            </div>
          </div>

          {/* Machines */}
          <div className="space-y-6" data-slide-pausing={slideAnimating ? 'true' : undefined}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg md:text-xl font-bold text-foreground">machines</h3>

              <div className="flex items-center gap-2">
                {/* Add Machine Button */}
                <AddMachineButton
                  currentSiteId={DEMO_SITE_ID}
                  currentSiteName={DEMO_SITE.name}
                />

                {/* Expand/Collapse All + View Toggle */}
                <div className="flex items-center gap-1 rounded-lg bg-card-sunken p-1 select-none">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={toggleAllProcesses}
                        aria-label={allExpanded ? 'collapse all' : 'expand all'}
                        className="cursor-pointer text-muted-foreground"
                      >
                        {allExpanded ? <ChevronsDownUp className="h-4 w-4" /> : <ChevronsUpDown className="h-4 w-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{allExpanded ? 'collapse all' : 'expand all'}</p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="h-4 w-px bg-border" />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewType('card')}
                        aria-label="card view"
                        className={`cursor-pointer ${viewType === 'card' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
                      >
                        <LayoutGrid className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>card view</p>
                    </TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setViewType('list')}
                        aria-label="list view"
                        className={`cursor-pointer ${viewType === 'list' ? 'bg-secondary text-accent-cyan' : 'text-muted-foreground'}`}
                      >
                        <List className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>list view</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </div>

            {/* Card View */}
            {viewType === 'card' && (
              <div className="animate-in fade-in duration-300">
                <MachineCardView
                  machines={machines}
                  statsExpanded={statsExpanded}
                  processesExpanded={allExpanded}
                  onToggleStats={toggleStats}
                  onToggleProcesses={toggleAllProcesses}
                  currentSiteId={DEMO_SITE_ID}
                  siteTimezone={DEMO_SITE.timezone}
                  siteTimeFormat="12h"
                  onEditProcess={noop}
                  onCreateProcess={noop}
                  onKillProcess={noop}
                  onRestartProcess={noop}
                  onSetLaunchMode={noop}
                  onRemoveMachine={noop}
                  onMetricClick={handleMetricClick}
                  onRestart={noopAsync}
                  onShutdown={noopAsync}
                  onCancelRestart={noopAsync}
                  onDismissRestartPending={noopAsync}
                />
              </div>
            )}

            {/* List View */}
            {viewType === 'list' && (
              <div className="rounded-xl border border-border/60 bg-card-sunken overflow-hidden animate-in fade-in duration-300">
                <Table style={{ contain: 'layout', tableLayout: 'fixed' }}>
                  <ListViewTableHeader />
                  <TableBody>
                    {machines.map((machine) => (
                      <MachineRow
                        key={machine.machineId}
                        machine={machine}
                        isExpanded={expandedMachineIds.has(machine.machineId)}
                        currentSiteId={DEMO_SITE_ID}
                        siteTimezone={DEMO_SITE.timezone}
                        siteTimeFormat="12h"
                        userPreferences={{ temperatureUnit: 'C' }}
                        isSiteAdmin={false}
                        onToggleExpanded={() => toggleMachineExpanded(machine.machineId)}
                        onEditProcess={noop}
                        onCreateProcess={noop}
                        onKillProcess={noop}
                        onRestartProcess={noop}
                        onSetLaunchMode={noop}
                        onRemoveMachine={noop}
                        onMetricClick={(metricType) => handleMetricClick(machine.machineId, metricType)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
         </>)}
        </main>
      </div>
    </DemoContext.Provider>
  );
}
