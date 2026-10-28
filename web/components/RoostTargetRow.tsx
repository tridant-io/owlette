'use client';

/**
 * RoostTargetsList — checkbox list of the site's machines for the selected roost;
 * checked rows are `roost.targets`. Toggling fires a debounced PATCH and the
 * `useRoosts` snapshot listener reconciles on confirmation.
 *
 * Owns ONE `useTargetStates` listener per expanded roost.
 */

import React, { useState } from 'react';
import { CheckCircle2, CircleDashed, Download, FileCog, Loader2, XCircle, Ban, AlertTriangle } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTargetStates, type TargetState, type TargetStatus } from '@/hooks/useTargetStates';
import type { Machine } from '@/hooks/useFirestore';

interface RoostTargetsListProps {
  siteId: string;
  roostId: string;
  currentVersionId: string | null;
  targets: string[];
  machines: Machine[];
}

interface RoostStatusPillProps {
  siteId: string;
  roostId: string;
  currentVersionId: string | null;
  targets: string[];
}

type RollupStatus =
  | 'synced'      // all targets committed for the current version
  | 'syncing'     // at least one target in-flight, none failed
  | 'partial'     // some targets synced, some still pending / in-flight
  | 'pending'     // no target has started yet
  | 'failed'      // at least one target reported failed
  | 'unreported'; // zero targets, or nothing reported + can't tell

interface StatusPresentation {
  label: string;
  className: string;
  icon: React.ComponentType<{ className?: string }>;
  spin?: boolean;
}

/**
 * A report for an OLD version means "pending" on the current rollout — showing its
 * stale `committed` would read as "this deploy landed".
 */
function effectiveStatus(
  state: TargetState | undefined,
  currentVersionId: string | null,
): TargetStatus | 'stale' | 'unreported' {
  if (!state || !state.status) return 'unreported';
  const isForCurrent =
    !!currentVersionId && state.reportedVersionId === currentVersionId;
  if (!isForCurrent) return 'stale';
  return state.status;
}

function presentation(status: TargetStatus | 'stale' | 'unreported'): StatusPresentation {
  switch (status) {
    case 'committed':
      return {
        label: 'synced',
        className: 'bg-success-surface text-success border-success-border',
        icon: CheckCircle2,
      };
    case 'downloading':
      return {
        label: 'downloading',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: Download,
      };
    case 'assembling':
      return {
        label: 'assembling',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: FileCog,
      };
    case 'pending':
      return {
        label: 'queued',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Loader2,
        spin: true,
      };
    case 'failed':
      return {
        label: 'failed',
        className: 'bg-danger/10 text-danger border-danger/30',
        icon: XCircle,
      };
    case 'cancelled':
      return {
        label: 'cancelled',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Ban,
      };
    case 'stale':
      return {
        label: 'awaiting agent',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
    case 'unreported':
    default:
      return {
        label: 'no report yet',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
  }
}

function metricLine(
  state: TargetState | undefined,
  status: TargetStatus | 'stale' | 'unreported',
): string | null {
  if (!state) return null;
  if (status === 'downloading') {
    const total = state.chunksTotal ?? 0;
    const done = state.chunksFetched ?? 0;
    if (total > 0) return `${done}/${total} chunks`;
    return null;
  }
  if (status === 'assembling') {
    const total = state.filesTotal ?? 0;
    if (total > 0) return `${total} files`;
    return null;
  }
  if (status === 'committed') {
    const files = state.filesAssembled ?? 0;
    const dedup = state.chunksDedup ?? 0;
    const parts: string[] = [];
    if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
    if (dedup > 0) parts.push(`${dedup} dedup`);
    return parts.length ? parts.join(' · ') : null;
  }
  return null;
}

/**
 * Roll per-machine states up for the collapsed row. Only reports for the current
 * version count, so an old `committed` can't make the new rollout look done.
 */
function rollup(
  targets: string[],
  currentVersionId: string | null,
  byMachine: Map<string, TargetState>,
): { status: RollupStatus; synced: number; total: number; failed: number; inFlight: number } {
  const total = targets.length;
  if (total === 0) {
    return { status: 'unreported', synced: 0, total: 0, failed: 0, inFlight: 0 };
  }
  let synced = 0;
  let failed = 0;
  let inFlight = 0; // downloading | assembling | pending
  let reported = 0;
  for (const mid of targets) {
    const s = byMachine.get(mid);
    if (!s || !s.status) continue;
    if (currentVersionId && s.reportedVersionId !== currentVersionId) continue;
    reported++;
    switch (s.status) {
      case 'committed':
        synced++;
        break;
      case 'failed':
        failed++;
        break;
      case 'downloading':
      case 'assembling':
      case 'pending':
        inFlight++;
        break;
    }
  }
  let status: RollupStatus;
  if (failed > 0) status = 'failed';
  else if (synced === total) status = 'synced';
  else if (inFlight > 0 && synced === 0) status = 'syncing';
  else if (inFlight > 0) status = 'partial';
  else if (reported === 0) status = 'pending';
  else status = 'partial';
  return { status, synced, total, failed, inFlight };
}

function rollupPresentation(status: RollupStatus): StatusPresentation {
  switch (status) {
    case 'synced':
      return {
        label: 'synced',
        className: 'bg-success-surface text-success border-success-border',
        icon: CheckCircle2,
      };
    case 'syncing':
      return {
        label: 'syncing',
        className: 'bg-accent-cyan/10 text-accent-cyan border-accent-cyan/30',
        icon: Download,
      };
    case 'partial':
      return {
        label: 'partial',
        className: 'bg-warning-surface text-warning border-warning-solid/30',
        icon: AlertTriangle,
      };
    case 'pending':
      return {
        label: 'queued',
        className: 'bg-muted text-muted-foreground border-border',
        icon: Loader2,
        spin: true,
      };
    case 'failed':
      return {
        label: 'failed',
        className: 'bg-danger/10 text-danger border-danger/30',
        icon: XCircle,
      };
    case 'unreported':
    default:
      return {
        label: 'no targets',
        className: 'bg-muted text-muted-foreground border-border',
        icon: CircleDashed,
      };
  }
}

/**
 * Status pill for the collapsed roost row. One listener per roost (the
 * target_state subcollection is small). When expanded, both this and
 * `RoostTargetsList` stay mounted and share the snapshot via Firestore's cache.
 */
export function RoostStatusPill({
  siteId,
  roostId,
  currentVersionId,
  targets,
}: RoostStatusPillProps) {
  const { states, loading } = useTargetStates(siteId, roostId);
  const byMachine = React.useMemo(() => {
    const m = new Map<string, TargetState>();
    for (const s of states) m.set(s.machineId, s);
    return m;
  }, [states]);
  const r = React.useMemo(
    () => rollup(targets, currentVersionId, byMachine),
    [targets, currentVersionId, byMachine],
  );

  // Neutral placeholder before the first snapshot, so it can't flash "queued".
  if (loading && targets.length > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] bg-muted text-muted-foreground border-border">
        <Loader2 className="h-3 w-3 animate-spin" />
        checking
      </span>
    );
  }

  const pres = rollupPresentation(r.status);
  const Icon = pres.icon;
  // Counts on partial/syncing/failed, and on fully-synced so "synced (3/3)"
  // confirms the total at a glance.
  const showCount =
    r.total > 0 && (r.status === 'synced' || r.status === 'partial' || r.status === 'syncing' || r.status === 'failed');
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${pres.className}`}
    >
      <Icon className={`h-3 w-3 ${pres.spin ? 'animate-spin' : ''}`} />
      {pres.label}
      {showCount && (
        <span className="tabular-nums opacity-80">
          {r.synced}/{r.total}
        </span>
      )}
    </span>
  );
}

export function RoostTargetsList({
  siteId,
  roostId,
  currentVersionId,
  targets,
  machines,
}: RoostTargetsListProps) {
  const { states } = useTargetStates(siteId, roostId);
  // O(1) row lookup; rebuilt on snapshot change, not on every parent render.
  const byMachine = React.useMemo(() => {
    const m = new Map<string, TargetState>();
    for (const s of states) m.set(s.machineId, s);
    return m;
  }, [states]);

  // Optimistic mirror so the checkbox flips on click; the snapshot reconciles
  // within ~1s via the `targets` prop dependency below.
  const [localTargets, setLocalTargets] = useState<Set<string>>(
    () => new Set(targets),
  );
  React.useEffect(() => {
    setLocalTargets(new Set(targets));
  }, [targets]);

  // Ignore responses from superseded clicks when a row is toggled twice fast.
  const seqRef = React.useRef(0);
  const [busy, setBusy] = React.useState(false);

  const persist = React.useCallback(
    async (nextTargets: string[], previousTargets: Set<string>) => {
      const seq = ++seqRef.current;
      setBusy(true);
      // Adding a target implies "send it the current version now", so deploy
      // automatically. Removals need no follow-up.
      const added = nextTargets.filter((m) => !previousTargets.has(m));
      try {
        const res = await fetch(
          `/api/roosts/${encodeURIComponent(roostId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteId, targets: nextTargets }),
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.detail ?? body.title ?? `HTTP ${res.status}`);
        }
        if (added.length > 0 && currentVersionId) {
          const deployRes = await fetch(
            `/api/roosts/${encodeURIComponent(roostId)}/deploy`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ siteId, machines: added }),
            },
          );
          if (!deployRes.ok) {
            const body = await deployRes.json().catch(() => ({}));
            // Don't revert: the target IS in the list; "re-sync targets" retries.
            toast.error('queued, but failed to dispatch sync', {
              description: body.detail ?? body.title ?? `HTTP ${deployRes.status}`,
            });
          } else {
            toast.success(
              `syncing ${added.length} new target${added.length === 1 ? '' : 's'}`,
            );
          }
        }
      } catch (err) {
        if (seq === seqRef.current) {
          // Only the latest dispatch matters; older ones were superseded.
          setLocalTargets(previousTargets);
          toast.error('failed to update targets', {
            description: err instanceof Error ? err.message : 'network error',
          });
        }
      } finally {
        if (seq === seqRef.current) setBusy(false);
      }
    },
    [roostId, siteId, currentVersionId],
  );

  const toggle = React.useCallback(
    (machineId: string) => {
      const previous = localTargets;
      const next = new Set(previous);
      if (next.has(machineId)) {
        next.delete(machineId);
      } else {
        next.add(machineId);
      }
      setLocalTargets(next);
      void persist(Array.from(next), previous);
    },
    [localTargets, persist],
  );

  if (machines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground italic">
        no machines on this site yet — install the agent on one to add it as a target.
      </p>
    );
  }

  // targeted+online → targeted+offline → untargeted+online → untargeted+offline,
  // then machineId asc: active fleet on top, "add a target" right below.
  const sorted = [...machines].sort((a, b) => {
    const aTarget = localTargets.has(a.machineId) ? 0 : 1;
    const bTarget = localTargets.has(b.machineId) ? 0 : 1;
    if (aTarget !== bTarget) return aTarget - bTarget;
    const aOnline = a.online ? 0 : 1;
    const bOnline = b.online ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return a.machineId.localeCompare(b.machineId);
  });

  return (
    <div className="space-y-1.5">
      {sorted.map((m) => {
        const isTarget = localTargets.has(m.machineId);
        return (
          <TargetCheckboxRow
            key={m.machineId}
            machine={m}
            isTarget={isTarget}
            currentVersionId={currentVersionId}
            state={byMachine.get(m.machineId)}
            disabled={busy}
            onToggle={() => toggle(m.machineId)}
          />
        );
      })}
    </div>
  );
}

function TargetCheckboxRow({
  machine,
  isTarget,
  currentVersionId,
  state,
  disabled,
  onToggle,
}: {
  machine: Machine;
  isTarget: boolean;
  currentVersionId: string | null;
  state: TargetState | undefined;
  disabled: boolean;
  onToggle: () => void;
}) {
  const status = effectiveStatus(state, currentVersionId);
  const pres = presentation(status);
  const Icon = pres.icon;
  const metrics = metricLine(state, status);

  return (
    <label
      className={`flex items-center justify-between gap-3 py-1.5 px-3 rounded border transition-colors cursor-pointer ${
        isTarget
          ? 'border-border bg-background/50 hover:bg-muted/40'
          : 'border-border/40 bg-transparent hover:bg-muted/20'
      } ${disabled ? 'opacity-60 pointer-events-none' : ''}`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <input
          type="checkbox"
          checked={isTarget}
          onChange={onToggle}
          disabled={disabled}
          className="h-4 w-4 rounded border-border bg-background accent-accent-cyan cursor-pointer flex-shrink-0"
          aria-label={isTarget ? `remove ${machine.machineId} as target` : `add ${machine.machineId} as target`}
        />
        <span className="text-foreground text-sm select-text truncate min-w-0">
          {machine.machineId}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {isTarget && metrics && (
          <span className="text-[11px] text-muted-foreground tabular-nums select-none">
            {metrics}
          </span>
        )}
        {isTarget && (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${pres.className}`}
            title={state?.error ?? undefined}
          >
            <Icon className={`h-3 w-3 ${pres.spin ? 'animate-spin' : ''}`} />
            {pres.label}
          </span>
        )}
        <span
          className={`inline-flex items-center gap-1 text-[11px] ${
            machine.online ? 'text-success' : 'text-muted-foreground'
          }`}
          title={machine.online ? 'online' : 'offline'}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              machine.online ? 'bg-success' : 'bg-muted-foreground/60'
            }`}
            aria-hidden="true"
          />
          {machine.online ? 'online' : 'offline'}
        </span>
      </div>
    </label>
  );
}
