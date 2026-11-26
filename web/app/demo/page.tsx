'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { PageCascade } from '@/components/PageCascade';
import { PageHeader } from '@/components/PageHeader';
import { MetricsDetailPanel, type MetricType } from '@/components/charts';
import { DisplayLayoutPanel } from '@/components/charts/DisplayLayoutPanel';
import { MachineCardView } from '@/app/dashboard/components/MachineCardView';
import { MachineRow, MachineTable } from '@/app/dashboard/components/MachineListView';
import { AddMachineButton } from '@/app/dashboard/components/AddMachineButton';
import { DashboardWelcome } from '@/app/dashboard/components/DashboardWelcome';
import { MachinesHeading, type ViewType } from '@/app/dashboard/components/MachinesHeading';
import { useDevicePrefs } from '@/hooks/useDevicePrefs';
import { useSlidePanel } from '@/hooks/useSlidePanel';
import { DEMO_SITE_ID, DEMO_SITE, getDemoMachines } from '@/lib/demo-data';

interface DetailPanelState {
  machineId: string;
  machineName: string;
  metric: MetricType;
}

// No-op async handler for required Promise-returning props
const noopAsync = async () => {};
// No-op sync handler
const noop = () => {};
const SITES = [DEMO_SITE];

/**
 * the dashboard on sample data: the same header, rows, cards and panels,
 * handed demo machines. `layout.tsx` wraps it in the demo's provider, which the
 * hooks underneath read instead of firestore.
 */
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
  // the card view's sections, which the dashboard keeps in the user's preferences
  const [statsExpanded, setStatsExpanded] = useState(false);
  const [processesExpanded, setProcessesExpanded] = useState(false);
  const [displaysExpanded, setDisplaysExpanded] = useState(false);
  const [detailPanel, setDetailPanel] = useState<DetailPanelState | null>(null);
  const { prefs: devicePrefs, setListPref } = useDevicePrefs();

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

  // as the dashboard's: every row and every card section opens, or all close
  const toggleAllExpanded = useCallback(() => {
    const expand = !allExpanded;
    setExpandedMachineIds(expand ? new Set(machines.map(m => m.machineId)) : new Set());
    setStatsExpanded(expand);
    setProcessesExpanded(expand);
    setDisplaysExpanded(expand);
  }, [allExpanded, machines]);

  const toggleMachineExpanded = useCallback((machineId: string) => {
    setExpandedMachineIds(prev => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const toggleStats = useCallback(() => setStatsExpanded(v => !v), []);
  const toggleProcesses = useCallback(() => setProcessesExpanded(v => !v), []);
  const toggleDisplays = useCallback(() => setDisplaysExpanded(v => !v), []);

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

  return (
    <PageCascade className="relative min-h-screen pb-24">
      {/* Header */}
      <PageHeader
        currentPage="dashboard"
        sites={SITES}
        currentSiteId={DEMO_SITE_ID}
        onSiteChange={noop}
        disableNav
      />

      {/* Demo banner */}
      <div className="relative z-10 bg-accent-cyan/10 border-b border-accent-cyan/20">
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
        <DashboardWelcome
          greeting="welcome to owlette!"
          subtitle="keeping your pixels in good hands"
          machines={machines}
        />

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
                  gpus={machines.find((m) => m.machineId === heldDetailPanel.machineId)?.devices?.gpus}
                  machines={machines}
                  onSwitchMachine={handleSwitchMachine}
                />
              )
            )}
          </div>
        </div>

        {/* Machines */}
        <div className="space-y-6" data-slide-pausing={slideAnimating ? 'true' : undefined}>
          <MachinesHeading
            allExpanded={allExpanded}
            onToggleAll={toggleAllExpanded}
            viewType={viewType}
            onViewChange={setViewType}
          >
            <AddMachineButton
              currentSiteId={DEMO_SITE_ID}
              currentSiteName={DEMO_SITE.name}
            />
          </MachinesHeading>

          {/* Card View */}
          {viewType === 'card' && (
            <div className="animate-in fade-in duration-300">
              <MachineCardView
                machines={machines}
                statsExpanded={statsExpanded}
                processesExpanded={processesExpanded}
                displaysExpanded={displaysExpanded}
                onToggleStats={toggleStats}
                onToggleProcesses={toggleProcesses}
                onToggleDisplays={toggleDisplays}
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
            <MachineTable machines={machines} listPref={devicePrefs.listView} setListPref={setListPref}>
              {machines.map((machine) => (
                <MachineRow
                  key={machine.machineId}
                  machine={machine}
                  listPref={devicePrefs.listView}
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
            </MachineTable>
          )}
        </div>
       </>)}
      </main>
    </PageCascade>
  );
}
