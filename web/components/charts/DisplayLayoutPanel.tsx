'use client';

/**
 * Expanded panel for inspecting and (admin-only) managing a machine's display
 * topology; chrome mirrors MetricsDetailPanel.
 *
 * Tabs: `live` (agent's latest report, via useDisplayState) and `assigned` (the
 * admin-authored target). When an assigned layout exists the live tab overlays
 * it as dashed ghosts so drift is visible. store/restore are writes and are
 * hidden entirely for non-admins.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { toast } from '@/lib/toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, Loader2, Monitor, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import {
  useDisplayState,
  computeDisplayDrift,
  totalDriftCount,
  type MonitorInfo,
} from '@/hooks/useDisplayState';
import { useDisplayActions } from '@/hooks/useDisplayActions';
import { useCommandResult } from '@/hooks/useCommandResult';
import {
  useAckBanner,
  startAckCountdown,
  clearAckCountdown,
  setAckInFlight,
} from '@/hooks/useAckBanner';
import { useDisplayDraft } from '@/hooks/useDisplayDraft';
import { useDisplayModes } from '@/hooks/useDisplayModes';
import {
  useDisplayEventFeed,
  type DisplayEventEntry,
} from '@/hooks/useDisplayEventFeed';
import { DisplayCanvas } from './DisplayCanvas';
import { DisplayMonitorTable } from './DisplayMonitorTable';
import { DisplayEditorDialog } from './DisplayEditorDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface DisplayLayoutPanelProps {
  machineId: string;
  machineName?: string;
  siteId: string;
  /** The machine's agent-written `capabilities` map, handed down from the
   * machines subscription; `displayRemoteApply` gates restore. */
  capabilities?: Record<string, number>;
  onClose: () => void;
}

type DisplayTab = 'live' | 'assigned' | 'events';

const DISPLAY_EVENT_LABEL: Record<string, string> = {
  display_monitor_removed: 'monitor removed',
  display_apply_failed: 'apply failed',
  display_auto_revert_fired: 'auto-reverted',
  display_sync_lost: 'sync lost',
  display_drift: 'drift',
  display_monitor_swapped: 'monitor swapped',
  display_mosaic_disabled: 'mosaic disabled',
  display_apply_refused_mosaic: 'apply refused (mosaic)',
  display_monitor_added: 'monitor added',
  display_apply_succeeded: 'apply succeeded',
  display_apply_acked: 'apply confirmed',
  display_revert_deferred: 'revert deferred',
  display_auto_restore_fired: 'auto-restored',
  display_auto_restore_skipped_unfixable: 'auto-restore skipped',
  display_auto_restore_circuit_breaker_tripped: 'auto-restore paused',
};

/**
 * Epoch ms → "just now" / "Nm ago" / "Nh ago" / "Nd ago", "MMM D" past a week.
 * Local because the shared `formatRelativeTime` takes seconds and never
 * falls back to a date.
 */
function formatEventRelativeTime(epochMs: number): string {
  if (!epochMs) return '—';
  const diffMs = Date.now() - epochMs;
  if (diffMs < 60_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Parse the JSON-serialized agent payload, returning {} on any failure. */
function parseEventDetails(details: string): Record<string, unknown> {
  if (!details) return {};
  try {
    const parsed = JSON.parse(details) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Monitor name from a parsed event payload (`{monitor:{friendlyName}}`); '' renders an em-dash. */
function eventMonitorName(payload: Record<string, unknown>): string {
  const monitor = payload.monitor;
  if (monitor && typeof monitor === 'object') {
    const fn = (monitor as { friendlyName?: unknown }).friendlyName;
    if (typeof fn === 'string') return fn;
  }
  return '';
}

/**
 * Per-action details: `display_drift` → `changes.join(', ')`,
 * `display_apply_failed` → `error`, everything else → '' (em-dash cell).
 */
function eventDetailsSnippet(
  action: string,
  payload: Record<string, unknown>,
): string {
  if (action === 'display_drift') {
    const changes = payload.changes;
    if (Array.isArray(changes)) {
      return changes.filter((c): c is string => typeof c === 'string').join(', ');
    }
    return '';
  }
  if (action === 'display_apply_failed') {
    const err = payload.error;
    if (typeof err === 'string') return err;
  }
  return '';
}

/** Severity badge classes — amber-500 / destructive tokens used elsewhere here. */
function eventLevelBadgeClass(level: string): string {
  if (level === 'critical') {
    return 'bg-destructive/20 text-destructive border-destructive/30';
  }
  if (level === 'warning') {
    return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  }
  return 'bg-muted text-muted-foreground border-border';
}

/** Sort left-to-right, top-to-bottom by virtual-desktop position so the stat-card grid matches on-screen order. */
function sortByPosition(monitors: MonitorInfo[]): MonitorInfo[] {
  return [...monitors].sort((a, b) => {
    if (a.position.x !== b.position.x) return a.position.x - b.position.x;
    return a.position.y - b.position.y;
  });
}

/**
 * True if any two monitors overlap in virtual-desktop space. Advisory only —
 * Windows tolerates overlaps. Rotation swaps effective width/height.
 */
function hasOverlappingMonitors(monitors: MonitorInfo[]): boolean {
  const rect = (m: MonitorInfo) => {
    const rot = m.rotation % 180;
    const w = rot === 0 ? m.resolution.width : m.resolution.height;
    const h = rot === 0 ? m.resolution.height : m.resolution.width;
    return { x: m.position.x, y: m.position.y, w, h };
  };
  for (let i = 0; i < monitors.length; i++) {
    const a = rect(monitors[i]);
    for (let j = i + 1; j < monitors.length; j++) {
      const b = rect(monitors[j]);
      if (
        a.x < b.x + b.w &&
        a.x + a.w > b.x &&
        a.y < b.y + b.h &&
        a.y + a.h > b.y
      ) {
        return true;
      }
    }
  }
  return false;
}

export function DisplayLayoutPanel({
  machineId,
  machineName,
  siteId,
  capabilities,
  onClose,
}: DisplayLayoutPanelProps) {
  const { isSiteAdmin, user } = useAuth();
  const canSiteAdmin = isSiteAdmin(siteId);
  const { profile, assigned, autoRestore, remoteApplyEnabled, loading, error } = useDisplayState(siteId, machineId);
  // `applying` disables every write button so in-flight repeat-clicks are blocked.
  const actions = useDisplayActions(siteId, machineId);

  const [activeTab, setActiveTab] = useState<DisplayTab>('live');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [selectedMonitorId, setSelectedMonitorId] = useState<string | undefined>(
    undefined,
  );
  const [captureDialogOpen, setCaptureDialogOpen] = useState(false);
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [applyDialogOpen, setApplyDialogOpen] = useState(false);
  const [enableRemoteApplyDialogOpen, setEnableRemoteApplyDialogOpen] = useState(false);
  const [closeUnsavedDialogOpen, setCloseUnsavedDialogOpen] = useState(false);
  // [A2.6] Monitor being edited in DisplayEditorDialog (double-click a rect or
  // row). Dialog saves go through the draft via `updateMonitor`, not Firestore.
  const [editingMonitorId, setEditingMonitorId] = useState<string | null>(null);
  // [A4.2] Start-from-live handoff: flag + mode='edit' flip together, and the
  // effect below replaces useDisplayDraft's (empty) assigned seed with a clone
  // of live, then clears it. Also read by the render-phase guard so a mid-seed
  // session isn't snapped back to view. State, not ref, so render reads lint clean.
  const [pendingSeedFromLive, setPendingSeedFromLive] = useState(false);

  // [A4.3] signatureHash captured on view→edit, so a diverging live hash can
  // prompt "hardware changed: reload or keep editing". Captured during render
  // (not an effect) to avoid a one-render null baseline reporting a spurious change.
  const [editEntryHash, setEditEntryHash] = useState<string | null>(null);
  const [prevModeForHash, setPrevModeForHash] = useState<'view' | 'edit'>(
    mode,
  );
  if (mode !== prevModeForHash) {
    setPrevModeForHash(mode);
    setEditEntryHash(mode === 'edit' ? profile?.signatureHash ?? null : null);
  } else if (
    mode === 'edit' &&
    editEntryHash === null &&
    profile?.signatureHash
  ) {
    // Profile arrived after edit-mode entry; backfill so the first hash isn't
    // mis-reported as a change.
    setEditEntryHash(profile.signatureHash);
  }

  // [A3.3/A3.4] Display-mode catalogue for the resolution/refresh dropdowns.
  // Gated on edit mode so every opened panel doesn't hold a live listener.
  // `triggerForHash` fires the agent enumerate once per (site, machine, hash).
  const { catalogue: displayModes } = useDisplayModes(siteId, machineId, {
    enabled: mode === 'edit',
    triggerForHash: profile?.signatureHash,
  });

  const {
    draft,
    isDirty,
    updateMonitor,
    shiftSecondariesBy,
    resetToLive,
    clearDraft,
  } = useDisplayDraft({
    siteId,
    machineId,
    assigned,
    mode,
  });

  // Only the assigned canvas in edit mode wires this in; no-op keeps read-only elsewhere.
  const handleMonitorMove = useCallback(
    (id: string, position: { x: number; y: number }) => {
      updateMonitor(id, { position });
    },
    [updateMonitor],
  );

  // Dragging the primary becomes an inverse shift of every secondary, keeping
  // primary pinned at (0,0) in the model. Delta is incremental virtual units.
  const handleLayoutShift = useCallback(
    (dx: number, dy: number) => {
      shiftSecondariesBy(dx, dy);
    },
    [shiftSecondariesBy],
  );

  // Per-machine ack-banner state lives in a module-level hook so the countdown
  // (derived each tick from an absolute deadline) and the auto-revert toast
  // survive the panel closing.
  const { ackSecondsLeft, pendingApplyId, ackInFlight } = useAckBanner(
    siteId, machineId,
  );

  // Capability handshake on `capabilities.displayRemoteApply` (written by the
  // agent heartbeat, delivered by the machines subscription): below version 1
  // disables restore so a pre-Wave-3 agent never gets a command it can't dispatch.
  // The map is agent-written and unvalidated, so anything non-numeric — absent
  // included — gates off the same way rather than coercing into "supported".
  const remoteApplyVersion = capabilities?.displayRemoteApply;
  const agentSupportsApply =
    typeof remoteApplyVersion === 'number' && remoteApplyVersion >= 1;

  // Full drift report, keyed by live-id (live tab) or assigned-id (stored tab).
  // `addedHashes`/`removedHashes` cover what per-field maps can't express, e.g.
  // a disconnected monitor still present in the stored layout.
  const driftReport = useMemo(
    () =>
      computeDisplayDrift(
        profile?.monitors ?? [],
        assigned?.monitors ?? [],
      ),
    [profile, assigned],
  );

  const driftCount = totalDriftCount(driftReport);
  const hasDrift = driftCount > 0;

  // [A1.4] Drift signals zeroed in edit mode so deliberate edits aren't flagged.
  // Raw hasDrift stays for non-UI math; UI uses hasDriftVisible/effectiveDriftCount.
  const effectiveDriftCount = mode === 'edit' ? 0 : driftCount;
  const hasDriftVisible = mode === 'edit' ? false : hasDrift;

  // Drifted monitor ids for the canvas's amber stroke, taken from whichever
  // side of the drift report matches the active tab. Memoized for stable identity.
  const driftedMonitorIds = useMemo(
    () =>
      new Set(
        activeTab === 'live'
          ? driftReport.byLiveId.keys()
          : driftReport.byAssignedId.keys(),
      ),
    [driftReport, activeTab],
  );

  // Stable array refs so the sort/drift memos don't thrash: `profile?.monitors ?? []`
  // allocates a fresh array every render before the profile arrives.
  const liveMonitors = useMemo<MonitorInfo[]>(
    () => profile?.monitors ?? [],
    [profile],
  );
  const assignedMonitors = useMemo<MonitorInfo[]>(
    () => assigned?.monitors ?? [],
    [assigned],
  );

  // [A2.1/A1.5] In edit mode the draft is the source of truth for table, canvas
  // and ghost overlay; outside edit mode this collapses to the persisted value.
  const effectiveAssignedMonitors = useMemo<MonitorInfo[]>(
    () => (mode === 'edit' && draft ? draft : assignedMonitors),
    [mode, draft, assignedMonitors],
  );

  const sortedLive = useMemo(() => sortByPosition(liveMonitors), [liveMonitors]);
  const sortedAssigned = useMemo(
    () => sortByPosition(effectiveAssignedMonitors),
    [effectiveAssignedMonitors],
  );

  // [A4.1] Overlap check only while editing — a saved overlapping layout is deliberate.
  const draftHasOverlap = useMemo(() => {
    if (mode !== 'edit') return false;
    return hasOverlappingMonitors(effectiveAssignedMonitors);
  }, [mode, effectiveAssignedMonitors]);

  // Cards and canvas must share this sorted slice so selection and index labels
  // agree — they once diverged (canvas unsorted, table sorted) and "monitor #1"
  // meant different monitors in each pane.
  const cardsMonitors = activeTab === 'live' ? sortedLive : sortedAssigned;
  const canvasMonitors = cardsMonitors;
  // [A1.5] In edit mode the live tab's ghost overlay mirrors the draft (not
  // persisted assigned) and the drift filter relaxes — showing every pending change.
  const ghostMonitors = useMemo<MonitorInfo[] | undefined>(() => {
    if (activeTab !== 'live' || !assigned) return undefined;
    const source = mode === 'edit' && draft ? draft : assignedMonitors;
    if (mode === 'edit') {
      return source;
    }
    const liveByHash = new Map<string, MonitorInfo>();
    for (const m of liveMonitors) {
      if (m.edidHash) liveByHash.set(m.edidHash, m);
    }
    return source.filter((a) => {
      if (!a.edidHash) return true;
      const live = liveByHash.get(a.edidHash);
      if (!live) return true;
      return driftedMonitorIds.has(live.id);
    });
  }, [activeTab, assigned, assignedMonitors, liveMonitors, driftedMonitorIds, mode, draft]);

  // One accent per tab, threaded into canvas selection ring, card borders and
  // the apply button so every signal of the current mode reads as one color.
  // The read-only events tab keeps a neutral accent for pill consistency.
  const tabAccentColor =
    activeTab === 'live'
      ? 'var(--primary)'
      : activeTab === 'assigned'
        ? 'var(--chart-4)'
        : 'var(--muted-foreground)';

  // Event feed subscription opens only while the tab is active — otherwise every
  // background panel holds a 50-event listener.
  const {
    events: displayEvents,
    loading: eventsLoading,
    error: eventsError,
  } = useDisplayEventFeed(siteId, machineId, {
    enabled: activeTab === 'events',
  });

  const hasLiveProfile = !!profile && liveMonitors.length > 0;
  const hasAssignedLayout = !!assigned && assignedMonitors.length > 0;

  // [A4.3] Hardware-changed prompt: edit mode + baseline captured + live hash
  // diverged. Non-null guard avoids firing on first profile arrival.
  const hardwareChangedDuringEdit =
    mode === 'edit' &&
    editEntryHash !== null &&
    !!profile?.signatureHash &&
    profile.signatureHash !== editEntryHash;

  // [A4.4] Assigned-tab edidHashes absent from live topology — drives the
  // "not connected" badge. Live-tab monitors are connected by definition.
  // Includes the draft in edit mode so a live-seeded draft flags immediately.
  const staleEdidHashes = useMemo<Set<string> | undefined>(() => {
    if (activeTab !== 'assigned') return undefined;
    const liveHashes = new Set<string>();
    for (const m of liveMonitors) {
      if (m.edidHash) liveHashes.add(m.edidHash);
    }
    const stale = new Set<string>();
    for (const m of effectiveAssignedMonitors) {
      if (m.edidHash && !liveHashes.has(m.edidHash)) stale.add(m.edidHash);
    }
    return stale;
  }, [activeTab, liveMonitors, effectiveAssignedMonitors]);

  // [A1.2 / relaxed A4.2] Render-phase guard: snap back to view if the admin
  // flag disappears mid-edit, or if assigned is cleared with no draft and no
  // start-from-live handoff in flight (during that flow the draft is the
  // authority and save writes the first-ever assigned).
  // Also drops the sessionStorage draft — useDisplayDraft's edidHash staleness
  // check can't see the admin-flag case, so both reasons are handled here.
  const draftHasMonitors = !!draft && draft.length > 0;
  if (
    mode === 'edit' &&
    (!canSiteAdmin ||
      (!hasAssignedLayout &&
        !draftHasMonitors &&
        !pendingSeedFromLive))
  ) {
    setMode('view');
    clearDraft();
    setPendingSeedFromLive(false);
  }

  // store needs live data; restore needs an assigned layout, a capable agent and
  // the per-machine `displays.remoteApplyEnabled` switch (capability = agent can
  // dispatch, switch = machine may mutate Windows display state).
  const captureDisabled = !hasLiveProfile || actions.applying;
  const applyDisabled =
    !hasAssignedLayout || actions.applying || !agentSupportsApply || !remoteApplyEnabled;
  const editDisabled = !hasAssignedLayout || !!profile?.mosaicActive;

  // Stable handler so memoized children skip re-renders on unrelated parent state.
  const handleMonitorClick = useCallback((id: string) => {
    setSelectedMonitorId((prev) => (prev === id ? undefined : id));
  }, []);

  // Toast once per (machineId, signatureHash) when drift first appears mid-session,
  // never on mount — the tab badge already signals pre-existing drift.
  const seenDriftKeysRef = useRef(new Set<string>());
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    // [A1.4] No drift toasts while editing.
    if (mode === 'edit') return;

    // First commit: record state without toasting (pre-existing drift).
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      if (hasDrift && profile?.signatureHash) {
        seenDriftKeysRef.current.add(`${machineId}|${profile.signatureHash}`);
      }
      return;
    }

    if (!hasDrift || !profile?.signatureHash) return;

    const key = `${machineId}|${profile.signatureHash}`;
    if (seenDriftKeysRef.current.has(key)) return;
    seenDriftKeysRef.current.add(key);

    const noun = driftCount === 1 ? 'change' : 'changes';
    toast.info(
      `display drift detected on ${machineName || machineId} — ${driftCount} ${noun}. open stored tab to review.`,
      {
        action: { label: 'review', onClick: () => setActiveTab('assigned') },
      },
    );
  }, [hasDrift, profile?.signatureHash, machineId, machineName, driftCount, setActiveTab, mode]);

  /** Readable error string; String()-coerce the rest so no toast shows `[object Object]`. */
  const formatError = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    return String(e);
  };

  /**
   * Map an agent error code to a specific apply-failure toast. The service
   * serializes failures as `"Error: {code}: {message}"` (owlette_service.py),
   * so substring matching suffices. Today only Firestore-write failures reach
   * here; agent apply-result parsing lands in a follow-up.
   */
  const applyErrorToast = (e: unknown): string => {
    const msg = formatError(e);
    if (msg.includes('unsupported_mode')) {
      return (
"restore failed: one or more monitors can't do the requested " +
        'resolution or refresh rate — pick a supported mode from the ' +
        'dropdowns and try again'
      );
    }
    return `restore failed: ${msg}`;
  };

  // Snapshot `liveMonitors` at confirm-time, not dialog-open, so updates during
  // the dialog persist. ConfirmDialog self-closes on confirm; reopen on error.
  const handleCaptureConfirm = async () => {
    try {
      await actions.captureLayout(liveMonitors, user?.email ?? 'unknown');
      toast.success('layout stored');
    } catch (e) {
      console.error('Failed to store display layout', e);
      toast.error(`store failed: ${formatError(e)}`);
      setCaptureDialogOpen(true);
    }
  };

  const handleClearConfirm = async () => {
    try {
      await actions.clearLayout();
      toast.success('assigned layout cleared');
      clearDraft();
      setMode('view');
    } catch (e) {
      console.error('Failed to clear display layout', e);
      toast.error(`clear failed: ${formatError(e)}`);
      setClearDialogOpen(true);
    }
  };

  // Dispatch the assigned layout, then start the 30s ack countdown (module-level
  // so the banner survives panel close). Without a "keep" click the agent reverts.
  const handleApplyConfirm = async () => {
    try {
      const { applyId } = await actions.applyLayout(assignedMonitors);
      // Honest copy: the write landed; the agent hasn't seen the command yet.
      toast.success('restore dispatched — monitors will change shortly');
      startAckCountdown(siteId, machineId, applyId, Date.now() + 30_000);
    } catch (e) {
      console.error('Failed to restore display layout', e);
      toast.error(applyErrorToast(e));
      setApplyDialogOpen(true);
    }
  };

  // applyId scopes the ack to this banner's apply; a stale click is rejected.
  // Clear the banner only after the write resolves — clearing optimistically on
  // a failed write leaves the agent's auto-revert watchdog running with no
  // countdown to retry against, silently turning "keep" into a revert.
  // setAckInFlight disables the keep button so a double-click can't double-ack.
  const handleAckKeep = async () => {
    const applyId = pendingApplyId;
    if (!applyId) return;
    setAckInFlight(siteId, machineId, true);
    try {
      await actions.ackLayout(applyId);
      clearAckCountdown(siteId, machineId);
      // Honest copy: we only know the ack was written; the agent confirms via
      // `display_apply_acked`.
      toast.success('ack sent');
    } catch (e) {
      console.error('Failed to ack display layout', e);
      toast.error(`keep failed: ${formatError(e)} — try again before the countdown ends`);
      setAckInFlight(siteId, machineId, false);
    }
  };

  // Apply self-test: dispatch `test_display_apply` and read its result off the
  // completed-command doc, through a subscription scoped to that command id.
  // Hidden once remote apply is enabled, so a command that never lands needs no
  // timeout — closing the panel discards pending state. Clearing the id both
  // dismisses the banner and drops the listener.
  const [testApply, setTestApply] = useState<
    { machineId: string; cmdId: string } | null
  >(null);
  const [testApplyDispatching, setTestApplyDispatching] = useState(false);
  // Stamped with the machine it was dispatched for: switching the panel to
  // another machine reads as no command, so the listener drops rather than
  // waiting on a doc this command can never land in.
  const testApplyCmdId =
    testApply?.machineId === machineId ? testApply.cmdId : null;
  const testApplyResult = useCommandResult(siteId, machineId, testApplyCmdId);
  const testApplyInFlight =
    testApplyDispatching || (testApplyCmdId !== null && testApplyResult === null);

  const handleTestApply = async () => {
    setTestApply(null);
    setTestApplyDispatching(true);
    try {
      const cmdId = await actions.testDisplayApply();
      setTestApply({ machineId, cmdId });
      setTestApplyDispatching(false);
    } catch (e) {
      console.error('Failed to dispatch test_display_apply', e);
      toast.error(`test failed: ${formatError(e)}`);
      setTestApplyDispatching(false);
    }
  };

  // Countdown + auto-revert toast live in useAckBanner's shared 250ms tick, so
  // they fire even when this panel is unmounted.

  // [A1.2] Close-with-unsaved-changes gate. No countdown guard: banner state is
  // per-machine module state, so closing mid-countdown is safe.
  const handleCloseClick = () => {
    if (mode === 'edit' && isDirty) {
      setCloseUnsavedDialogOpen(true);
      return;
    }
    onClose();
  };

  // [A1.2] Discard + close confirmation.
  const handleDiscardAndClose = () => {
    clearDraft();
    setMode('view');
    onClose();
  };

  const handleDiscardEdit = () => {
    clearDraft();
    setMode('view');
    setPendingSeedFromLive(false);
  };

  // [A4.2] "start from live" on an empty assigned tab: set the handoff flag and
  // flip to edit, letting the effect below clone live into the draft AFTER
  // useDisplayDraft's mode-transition seed (which would stomp it with null).
  const handleSeedFromLive = () => {
    if (liveMonitors.length === 0) return;
    setPendingSeedFromLive(true);
    setMode('edit');
  };

  // Post-commit: useDisplayDraft has already seeded draft=null from the empty
  // assigned, so overwrite with a clone of live and clear the handoff flag.
  // Guarded on !draft so re-entry can't clobber in-progress edits.
  // The setPendingSeedFromLive(false) calls are a deliberate one-shot handoff
  // token (click handler → effect), not derivable state.
  useEffect(() => {
    if (!pendingSeedFromLive) return;
    if (mode !== 'edit') return;
    if (draft && draft.length > 0) {
      // Draft already populated — no-op; the flag clears on save/discard.
      return;
    }
    if (liveMonitors.length === 0) {
      // Live topology not in yet — retry on the render that brings monitors in.
      return;
    }
    resetToLive(liveMonitors);
    // One-shot completion signal, not derivable state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPendingSeedFromLive(false);
  }, [pendingSeedFromLive, mode, draft, liveMonitors, resetToLive]);

  // Save commits the draft through the same captureLayout path as store (draft
  // monitors instead of live); on success drop the draft and exit edit mode.
  const handleSaveDraft = async () => {
    if (!draft) return;
    try {
      await actions.captureLayout(draft, user?.email ?? 'unknown');
      toast.success('layout saved');
      clearDraft();
      setMode('view');
    } catch (e) {
      console.error('Failed to save draft', e);
      toast.error(`save failed: ${formatError(e)}`);
    }
  };

  const handleAutoRestoreToggle = async (next: boolean) => {
    try {
      await actions.setAutoRestore(next, user?.email ?? 'unknown');
    } catch (e) {
      console.error('Failed to update auto-restore', e);
      toast.error(`auto-restore update failed: ${formatError(e)}`);
    }
  };

  const handleEnableRemoteApply = async () => {
    try {
      await actions.setRemoteApplyEnabled(true);
      toast.success('restore enabled');
    } catch (e) {
      console.error('Failed to enable display restore', e);
      toast.error(`enable failed: ${formatError(e)}`);
    }
  };

  const handleResetBreaker = async () => {
    try {
      await actions.resetAutoRestoreBreaker();
      toast.success('auto-restore re-enabled');
    } catch (e) {
      console.error('Failed to reset auto-restore breaker', e);
      toast.error(`reset failed: ${formatError(e)}`);
    }
  };

  const autoRestoreDisabled =
    !hasAssignedLayout || !!profile?.mosaicActive || !remoteApplyEnabled || actions.applying;
  const autoRestoreDisabledReason = !hasAssignedLayout
    ? 'store a layout before enabling automatic restore'
    : profile?.mosaicActive
      ? "auto-restore can't run while nvidia mosaic is active"
      : !remoteApplyEnabled
        ? 'enable restore before enabling automatic restore'
        : autoRestore.enabled
          ? 'automatically reapplies the stored layout when this machine reports display drift'
          : 'turn on automatic restore so the agent reapplies the stored layout when display drift is detected';
  const breakerTripped = autoRestore.circuitBreaker.tripped;
  const breakerLastError =
    autoRestore.circuitBreaker.lastError || '(no error message)';

  const renderEventsTab = (
    events: DisplayEventEntry[],
    eventsLoadingArg: boolean,
    eventsErrorArg: string | null,
  ) => {
    if (eventsErrorArg) {
      return (
        <div
          className="h-[280px] flex items-center justify-center text-destructive text-sm"
          role="alert"
        >
          failed to load events — {eventsErrorArg}
        </div>
      );
    }
    if (eventsLoadingArg) {
      return (
        <div
          className="h-[280px] flex items-center justify-center"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="loading events"
        >
          <div className="text-muted-foreground animate-pulse text-sm">
            loading...
          </div>
        </div>
      );
    }
    if (events.length === 0) {
      return (
        <div className="h-[280px] flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground max-w-md">
            no display events yet. display changes will appear here.
          </p>
        </div>
      );
    }
    return (
      <div
        className="h-[280px] overflow-y-auto overflow-x-auto border border-border rounded-lg"
        data-testid="display-events-table"
      >
        {/* The declared column widths add up to 500px, so below that the table
            scrolls horizontally inside this container instead of crushing the
            columns (or widening the page). */}
        <table className="w-full min-w-[500px] text-xs">
          <thead className="bg-muted/40 text-muted-foreground sticky top-0 z-10">
            <tr>
              <th className="text-left font-normal px-3 py-1.5 w-[80px]">when</th>
              <th className="text-left font-normal px-3 py-1.5 w-[80px]">level</th>
              <th className="text-left font-normal px-3 py-1.5 w-[160px]">event</th>
              <th className="text-left font-normal px-3 py-1.5 w-[180px]">monitor</th>
              <th className="text-left font-normal px-3 py-1.5">details</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const payload = parseEventDetails(event.details);
              const monitorName = eventMonitorName(payload);
              const snippet = eventDetailsSnippet(event.action, payload);
              const label = DISPLAY_EVENT_LABEL[event.action] ?? event.action;
              return (
                <tr
                  key={event.id}
                  className="border-t border-border/60 hover:bg-accent/30"
                >
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                    {formatEventRelativeTime(event.timestamp)}
                  </td>
                  <td className="px-3 py-1.5">
                    <span
                      className={cn(
                        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                        eventLevelBadgeClass(event.level),
                      )}
                    >
                      {event.level || 'info'}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-foreground whitespace-nowrap">
                    {label}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground truncate">
                    {monitorName || '—'}
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground truncate">
                    {snippet || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  const renderBody = () => {
    // Events tab has its own loading/error/empty states — bypass the display-state
    // guards so a loading topology doesn't hide it.
    if (activeTab === 'events') {
      return renderEventsTab(displayEvents, eventsLoading, eventsError);
    }

    if (error) {
      return (
        <div
          className="h-[320px] flex items-center justify-center text-destructive text-sm"
          role="alert"
        >
          failed to load display data — {error}
        </div>
      );
    }

    if (loading) {
      return (
        <div
          className="h-[320px] flex items-center justify-center"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-label="loading displays"
        >
          <div className="text-muted-foreground animate-pulse text-sm">
            loading...
          </div>
        </div>
      );
    }

    // Tab-aware empty copy: "no live data" (agent-side) vs "no assigned layout"
    // (admin hasn't acted).
    if (activeTab === 'live' && !hasLiveProfile) {
      return (
        <div className="h-[320px] flex items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground max-w-md">
            no display data reported yet. data appears once the agent sends a
            display snapshot.
          </p>
        </div>
      );
    }

    // Suppressed in edit mode with a populated draft so a live-seeded session
    // renders the canvas instead of the empty state.
    const emptyAssignedVisible =
      activeTab === 'assigned' &&
      !hasAssignedLayout &&
      !(mode === 'edit' && draftHasMonitors);
    if (emptyAssignedVisible) {
      return (
        <div className="h-[320px] flex flex-col items-center justify-center px-6 text-center gap-3">
          <p className="text-sm text-muted-foreground max-w-md">
            nothing stored yet. store the current live arrangement as-is, or
            start from live to tweak before saving.
          </p>
          {canSiteAdmin && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={captureDisabled}
                onClick={() => setCaptureDialogOpen(true)}
                data-testid="display-store-current-button"
                className="h-7 px-2 text-xs"
              >
                {actions.applying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  'store current'
                )}
              </Button>
              {/* [A4.2] Start-from-live: enter edit mode with the draft
                  pre-seeded from the live topology. Equivalent to capture-
                  then-edit, but the operator gets a chance to tweak before
                  anything hits Firestore. */}
              <Button
                variant="outline"
                size="sm"
                disabled={liveMonitors.length === 0 || actions.applying}
                onClick={handleSeedFromLive}
                data-testid="display-start-from-live-button"
                className="h-7 px-2 text-xs"
              >
                start from live
              </Button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="animate-in fade-in duration-100 grid grid-cols-1 md:grid-cols-2 gap-0 bg-card rounded-lg">
        <div className="min-w-0 h-[280px] border border-border rounded-l-lg md:border-r-0 overflow-hidden bg-card">
          <DisplayCanvas
            monitors={canvasMonitors}
            mosaicGrids={activeTab === 'live' ? profile?.mosaicGrids : undefined}
            ghostMonitors={ghostMonitors}
            selectedMonitorId={selectedMonitorId}
            onMonitorClick={handleMonitorClick}
            accentColor={tabAccentColor}
            driftedMonitorIds={
              mode === 'edit'
                ? undefined
                : activeTab === 'live'
                  ? driftedMonitorIds
                  : undefined
            }
            staleEdidHashes={staleEdidHashes}
            editable={mode === 'edit' && activeTab === 'assigned'}
            onMonitorMove={
              mode === 'edit' && activeTab === 'assigned'
                ? handleMonitorMove
                : undefined
            }
            onMonitorDoubleClick={
              mode === 'edit' && activeTab === 'assigned'
                ? setEditingMonitorId
                : undefined
            }
            onLayoutShift={
              mode === 'edit' && activeTab === 'assigned'
                ? handleLayoutShift
                : undefined
            }
            className="h-[280px]"
          />
        </div>

        <DisplayMonitorTable
          monitors={cardsMonitors}
          selectedMonitorId={selectedMonitorId}
          onSelect={handleMonitorClick}
          onRowDoubleClick={
            mode === 'edit' && activeTab === 'assigned'
              ? setEditingMonitorId
              : undefined
          }
          accentColor={tabAccentColor}
          editable={mode === 'edit' && activeTab === 'assigned'}
          onUpdateMonitor={
            mode === 'edit' && activeTab === 'assigned'
              ? updateMonitor
              : undefined
          }
          modesByEdidHash={
            mode === 'edit' && activeTab === 'assigned'
              ? displayModes?.byEdidHash
              : undefined
          }
          driftMap={
            mode === 'edit'
              ? undefined
              : activeTab === 'live'
                ? driftReport.byLiveId
                : driftReport.byAssignedId
          }
        />
      </div>
    );
  };

  // Pill tab button — shared shape for live/assigned, each with its semantic accent.
  const renderTab = (tab: DisplayTab, label: string, badge?: string) => {
    const isActive = activeTab === tab;
    const ringColor =
      tab === 'live'
        ? 'var(--primary)'
        : tab === 'assigned'
          ? 'var(--chart-4)'
          : 'var(--muted-foreground)';
    return (
      <Button
        key={tab}
        variant="ghost"
        size="sm"
        onClick={() => setActiveTab(tab)}
        title={badge ? `${badge} display change${badge === '1' ? '' : 's'} from stored layout` : undefined}
        aria-label={badge ? `${label}, ${badge} display change${badge === '1' ? '' : 's'} from stored layout` : label}
        style={isActive ? { boxShadow: `inset 0 0 0 1px ${ringColor}` } : undefined}
        className={cn(
          'relative bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs transition-colors',
          isActive
            ? 'border-transparent text-white hover:bg-card'
            : 'hover:bg-card',
        )}
      >
        <span>{label}</span>
        {badge && (
          <span
            className="absolute -top-0.5 -right-0.5 inline-flex"
            aria-hidden="true"
          >
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
          </span>
        )}
      </Button>
    );
  };

  return (
    <Card
      data-testid="display-layout-panel"
      className="border-border bg-card-sunken py-0 gap-0"
    >
      <CardContent className="p-4">
        {/* Single header row: machine title, tabs, write actions, close.
            Consolidates the previous title + controls rows to save vertical
            space and put every panel control within one visual sweep. */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="flex items-center gap-2 text-xl font-semibold text-foreground shrink-0">
            <Monitor className="h-5 w-5 text-muted-foreground" />
            {machineName || machineId}
          </span>

          <div className="flex items-center gap-1.5">
            {renderTab('live', 'live')}
            {renderTab(
              'assigned',
              'stored',
              hasDriftVisible ? String(effectiveDriftCount) : undefined,
            )}
            {renderTab('events', 'events')}
            {mode === 'edit' && (
              <span className="text-[10px] text-muted-foreground px-2 py-1 rounded bg-muted/40 border border-border">
                editing stored — drift check paused
              </span>
            )}
          </div>

          {canSiteAdmin && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={autoRestoreDisabled ? 0 : -1}
                  className="flex items-center gap-2"
                >
                  <span className="text-xs text-muted-foreground">
                    auto-restore
                  </span>
                  <Switch
                    checked={autoRestore.enabled}
                    onCheckedChange={handleAutoRestoreToggle}
                    disabled={autoRestoreDisabled}
                    data-testid="display-auto-restore-toggle"
                    aria-label="auto-restore"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{autoRestoreDisabledReason}</TooltipContent>
            </Tooltip>
          )}

          <div className="flex-1" />

          {/* Admin action bar. Four verbs: store / restore / edit / discard.
                - live tab (view): store, restore
                - stored tab (view): restore, edit
                - edit mode: store, discard
              Restore is visible on both view tabs so drift can be fixed from
              wherever the operator noticed it. When auto-restore is enabled,
              its status chip occupies the same slot as the manual restore
              action. */}
          {canSiteAdmin && mode === 'view' && activeTab !== 'events' && (
            <div className="flex items-center gap-1.5">
              {/* Restore setup flow: test -> store -> restore. Test is a
                  pre-enable safety check; once restore is enabled, real
                  restore/auto-restore runs are the meaningful verification. */}
              {!remoteApplyEnabled && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={testApplyInFlight ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={testApplyInFlight}
                        onClick={handleTestApply}
                        data-testid="display-test-apply-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {testApplyInFlight ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'test'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    run a read-only apply self-test (no display changes) to
                    verify the helper works on this machine before enabling restore
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'live' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={captureDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={captureDisabled}
                        onClick={() => setCaptureDialogOpen(true)}
                        data-testid="display-store-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'store'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    store the current live arrangement as the stored layout
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'assigned' && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={editDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={editDisabled}
                        onClick={() => setMode('edit')}
                        data-testid="display-edit-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        edit
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!hasAssignedLayout
                      ? 'store a layout first'
                      : profile?.mosaicActive
                        ? 'editing unavailable while mosaic is active'
                        : 'edit the stored layout'}
                  </TooltipContent>
                </Tooltip>
              )}
              {activeTab === 'assigned' && hasAssignedLayout && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={actions.applying ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.applying}
                        onClick={() => setClearDialogOpen(true)}
                        data-testid="display-clear-button"
                        className="bg-card border border-border text-muted-foreground hover:text-destructive h-8 px-3 text-xs"
                      >
                        clear
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    remove the stored display layout from this machine
                  </TooltipContent>
                </Tooltip>
              )}
              {autoRestore.enabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      data-testid="display-auto-restore-status"
                      className="inline-flex h-8 items-center gap-1.5 rounded border border-border bg-card px-3 text-xs text-muted-foreground"
                    >
                      <span className="bg-green-500 rounded-full h-1.5 w-1.5" />
                      auto
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    auto-restore is enabled; the agent restores the stored
                    layout after it detects display drift
                  </TooltipContent>
                </Tooltip>
              ) : !remoteApplyEnabled ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={actions.applying ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actions.applying}
                        onClick={() => setEnableRemoteApplyDialogOpen(true)}
                        data-testid="display-enable-remote-apply-button"
                        className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'enable restore'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    allow admins to restore the stored display layout on this machine
                  </TooltipContent>
                </Tooltip>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={applyDisabled ? 0 : -1}>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={applyDisabled}
                        onClick={() => setApplyDialogOpen(true)}
                        data-testid="display-recall-button"
                        style={
                          hasDriftVisible
                            ? { boxShadow: 'inset 0 0 0 1px var(--chart-4)' }
                            : undefined
                        }
                        className={cn(
                          'bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs',
                          hasDriftVisible && 'border-transparent',
                        )}
                      >
                        {actions.applying ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          'restore'
                        )}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {!agentSupportsApply
                      ? 'agent too old'
                      : !remoteApplyEnabled
                        ? 'restore is disabled'
                        : hasDriftVisible
                        ? 'drift detected — restore the stored layout to fix it'
                        : 'restore the stored layout — push it to this machine'}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          )}

          {canSiteAdmin && mode === 'edit' && (
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={!isDirty || actions.applying ? 0 : -1}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!isDirty || actions.applying}
                      onClick={handleSaveDraft}
                      data-testid="display-save-button"
                      className="bg-card border border-border text-muted-foreground hover:text-white h-8 px-3 text-xs"
                    >
                      {actions.applying ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        'store'
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {isDirty
                    ? 'store edits as the stored layout'
                    : 'no unsaved changes'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={-1}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleDiscardEdit}
                      data-testid="display-discard-button"
                      className="bg-card border border-border text-muted-foreground hover:text-destructive h-8 px-3 text-xs"
                    >
                      discard
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>discard edits and return to view</TooltipContent>
              </Tooltip>
            </div>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCloseClick}
                className="bg-card border border-border text-muted-foreground hover:text-white h-8 w-8 p-0 shrink-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>close panel</TooltipContent>
          </Tooltip>
        </div>

        {ackSecondsLeft !== null && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="status"
            aria-live="polite"
          >
            <span className="text-amber-200">
              keep this layout? auto-revert in {ackSecondsLeft}s
            </span>
            <Button
              size="sm"
              onClick={handleAckKeep}
              disabled={ackInFlight}
              className="h-7 bg-amber-500 text-black hover:bg-amber-400"
            >
              {ackInFlight ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                'keep'
              )}
            </Button>
          </div>
        )}

        {draftHasOverlap && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-xs text-amber-200"
            role="status"
            aria-live="polite"
          >
            <span>monitors overlap — usually unintentional</span>
          </div>
        )}

        {breakerTripped && canSiteAdmin && (
          <div
            className="mt-3 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
            data-testid="display-auto-restore-breaker-banner"
          >
            <div className="flex items-center gap-2 min-w-0">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <span className="text-destructive truncate">
                auto-restore paused — 3 attempts failed. last error:{' '}
                {breakerLastError}.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetBreaker}
              disabled={actions.applying}
              data-testid="display-auto-restore-reset-button"
              className="h-7 px-2 text-xs shrink-0 bg-transparent border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              reset
            </Button>
          </div>
        )}

        {breakerTripped && !canSiteAdmin && (
          <div
            className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            role="status"
            data-testid="display-auto-restore-breaker-readonly"
          >
            <AlertTriangle className="h-4 w-4 text-amber-300 shrink-0" />
            <span className="text-amber-200 truncate">
              auto-restore paused — 3 attempts failed. last error:{' '}
              {breakerLastError}.
            </span>
          </div>
        )}

        <div
          className={cn(
            'grid transition-[grid-template-rows,opacity,margin] duration-300 ease-out',
            testApplyResult !== null
              ? 'mt-3 grid-rows-[1fr] opacity-100'
              : 'mt-0 grid-rows-[0fr] opacity-0',
          )}
        >
          <div className="overflow-hidden">
            {testApplyResult !== null && (
              <div
                key={testApplyResult}
                className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                role="status"
                aria-live="polite"
                data-testid="display-test-apply-result"
              >
                <span className="text-amber-200 truncate">
                  {testApplyResult}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTestApply(null)}
                  className="h-7 w-7 p-0 shrink-0 text-amber-200 hover:bg-amber-500/10 hover:text-amber-100"
                  aria-label="dismiss"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-3">{renderBody()}</div>
      </CardContent>

      {/* Store confirmation — replaces the stored layout (including any saved
          edits) with the current live arrangement. */}
      <ConfirmDialog
        open={captureDialogOpen}
        onOpenChange={setCaptureDialogOpen}
        title="store current arrangement?"
        description="this replaces the stored layout (including any saved edits) with the current live arrangement. the agent will keep monitors in this arrangement going forward."
        cancelText="cancel"
        confirmText="store"
        onConfirm={handleCaptureConfirm}
      />

      {/* Restore confirmation — kicks the agent to reconfigure the OS. Title
          includes machineName so bulk-operators don't fire against the wrong
          machine by accident. */}
      <ConfirmDialog
        open={clearDialogOpen}
        onOpenChange={setClearDialogOpen}
        title="clear assigned layout?"
        description="this removes the stored display layout. auto-restore and manual restore will stay unavailable until a layout is stored again."
        cancelText="cancel"
        confirmText="clear"
        variant="destructive"
        onConfirm={handleClearConfirm}
      />

      <ConfirmDialog
        open={applyDialogOpen}
        onOpenChange={setApplyDialogOpen}
        title={`restore this layout to ${machineName || machineId}?`}
        description="monitors will rearrange in a few seconds. owlette will auto-revert if no confirmation arrives within 30 seconds."
        cancelText="cancel"
        confirmText="restore"
        onConfirm={handleApplyConfirm}
      />

      <ConfirmDialog
        open={enableRemoteApplyDialogOpen}
        onOpenChange={setEnableRemoteApplyDialogOpen}
        title={`enable restore on ${machineName || machineId}?`}
        description="this allows owlette admins to remotely restore the stored display layout on this machine. use it only after the display apply test succeeds and you are ready for restore or auto-restore to move monitors."
        cancelText="cancel"
        confirmText="enable restore"
        onConfirm={handleEnableRemoteApply}
      />

      <ConfirmDialog
        open={closeUnsavedDialogOpen}
        onOpenChange={setCloseUnsavedDialogOpen}
        title="discard unsaved edits?"
        description="you have pending draft edits. close will discard them."
        cancelText="keep editing"
        confirmText="discard and close"
        onConfirm={handleDiscardAndClose}
      />

      {/* [A4.3] Hardware-changed prompt. Fires when the live profile's
          signatureHash diverges from the one captured at edit-mode entry —
          a monitor got plugged / unplugged / reconfigured while the
          operator was editing the stored layout. "reload from live" nukes
          the draft and clones the new live topology; "keep editing"
          suppresses the prompt (by advancing the baseline to the current
          hash) so it doesn't re-fire on every render, but leaves the
          draft intact. Escape / overlay close also advance the baseline
          so the operator can explicitly acknowledge and keep going. */}
      <ConfirmDialog
        open={hardwareChangedDuringEdit}
        onOpenChange={(next) => {
          if (!next) {
            // Advance the baseline on any close so it doesn't re-fire until the
            // next real hardware change.
            setEditEntryHash(profile?.signatureHash ?? null);
          }
        }}
        title="hardware changed"
        description="the machine's display configuration changed since you started editing. reload your draft from the new live layout?"
        cancelText="keep editing"
        confirmText="reload from live"
        onConfirm={() => {
          resetToLive(liveMonitors);
          setEditEntryHash(profile?.signatureHash ?? null);
        }}
      />

      {/* [A2.6] Per-monitor editor. Opens from double-click on a canvas rect
          or a table row when the panel is in edit mode on the assigned tab.
          Saves flow through the draft via `updateMonitor`, not Firestore. */}
      <DisplayEditorDialog
        monitor={
          editingMonitorId
            ? cardsMonitors.find((m) => m.id === editingMonitorId) ?? null
            : null
        }
        open={editingMonitorId !== null}
        onClose={() => setEditingMonitorId(null)}
        onSave={(changes) => {
          if (editingMonitorId) updateMonitor(editingMonitorId, changes);
        }}
      />
    </Card>
  );
}
