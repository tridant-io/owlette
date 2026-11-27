'use client';

import React, { useState } from 'react';
import { ArrowRightLeft, Loader2, Monitor, RotateCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { formatRelativeTime } from '@/lib/timeUtils';
import { activeHoursGuardOf, powerCommandParams, type PowerCommandOptions } from '@/lib/activeHours';
import { useMachineMove } from '@/hooks/useMachineMove';
import { useMachineOperations } from '@/hooks/useMachineOperations';
import { useSiteMachines, type SiteMachine } from '@/hooks/useSiteMachines';
import { RemoveMachineDialog } from '@/components/RemoveMachineDialog';
import { MoveMachineDialog } from '@/components/admin/sites/MoveMachineDialog';
import { MachinePowerConfirm, usePowerCommand } from '@/components/MachinePowerConfirm';

interface SiteMachinesListProps {
  siteId: string;
  siteName: string;
  /** the other sites the caller administers; with none, a machine offers no move */
  targetSites: { id: string; name: string }[];
}

/**
 * the machines section of a site's settings page (`/admin/sites/{siteId}?section=machines`).
 */
export function SiteMachinesList({ siteId, siteName, targetSites }: SiteMachinesListProps) {
  const { machines, error, refresh: fetchMachines } = useSiteMachines(siteId);
  // the target outlives the dialog's close, so its closing frames keep the same machine and choice
  const [restartTarget, setRestartTarget] = useState<SiteMachine | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SiteMachine | null>(null);
  const [moveTarget, setMoveTarget] = useState<SiteMachine | null>(null);
  const { removeMachineFromSite, removing } = useMachineOperations(siteId);
  const { cancelMove, busy: moveBusy } = useMachineMove(siteId);
  const power = usePowerCommand(siteId);

  const handleConfirmRestart = async (options: PowerCommandOptions) => {
    if (!restartTarget) return;
    const target = restartTarget;
    const queued = await power.send({
      machineId: target.id,
      machineName: target.name,
      action: 'restart',
      options,
      run: async (opts) => {
        // UI says "restart"; the wire verb deliberately stays "reboot".
        const response = await fetch(
          `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(target.id)}/commands`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Idempotency-Key': `machine-restart-${siteId}-${target.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            },
            body: JSON.stringify({ type: 'reboot_machine', params: powerCommandParams('restart', opts) }),
          },
        );
        if (!response.ok) throw new Error(`restart failed (${response.status})`);
        const body = (await response.json()) as { data: { commandId: string } };
        return { commandId: body.data.commandId };
      },
    });
    if (queued) setRestartOpen(false);
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeMachineFromSite(removeTarget.id);
      toast.success('machine removed', { description: `${removeTarget.name} is no longer on this site.` });
      setRemoveTarget(null);
      await fetchMachines();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('could not remove the machine', { description: message });
    }
  };

  const handleCancelMove = async (machine: SiteMachine) => {
    try {
      await cancelMove(machine.id);
      toast.success('move cancelled');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error('could not cancel the move', { description: message });
    }
    // a refused cancel means the move changed under the row (it is switching, or gone), so it reloads too
    await fetchMachines();
  };

  if (error) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="text-xs text-danger">{error}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void fetchMachines()}
          className="h-7 bg-secondary border border-border text-xs cursor-pointer"
        >
          retry
        </Button>
      </div>
    );
  }

  if (machines === null) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        loading machines…
      </div>
    );
  }

  if (machines.length === 0) {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground">no machines on this site</p>
    );
  }

  const lastSeen = (m: SiteMachine) => {
    if (m.online) return 'online';
    if (m.asleep) return 'asleep';
    if (!m.lastHeartbeat) return 'never seen';
    const parsed = Date.parse(m.lastHeartbeat);
    return Number.isNaN(parsed) ? 'unknown' : `last seen ${formatRelativeTime(parsed / 1000)}`;
  };

  return (
    <>
      <ul className="divide-y divide-border/40">
        {machines.map((m) => (
          <li
            key={m.id}
            className="grid grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_88px] items-center gap-3 px-3 py-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_88px]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${m.online ? 'bg-success' : m.asleep ? 'bg-info-solid' : 'bg-danger/70'}`}
              />
              <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-foreground" title={m.name}>
                {m.name}
              </span>
              {m.displayAwake?.held && (
                <span className="shrink-0 text-[10px] text-muted-foreground">awake</span>
              )}
              {/* a phone row has room for one word beside the name, as `awake` has; the site follows from sm up */}
              {m.pendingMove && (
                <>
                  <span
                    className="shrink-0 text-[10px] text-muted-foreground sm:hidden"
                    title={`moving to ${m.pendingMove.targetSiteName}`}
                  >
                    moving
                  </span>
                  <span className="hidden min-w-0 max-w-[50%] truncate text-[10px] text-muted-foreground sm:inline">
                    moving to {m.pendingMove.targetSiteName}
                  </span>
                </>
              )}
            </span>
            <span className={`min-w-0 truncate text-[11px] ${m.online ? 'text-success dark:text-success/90' : m.asleep ? 'text-info' : 'text-muted-foreground'}`}>
              {lastSeen(m)}
            </span>
            <span className="hidden min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:block">
              {m.agentVersion ? `v${m.agentVersion}` : '—'}
            </span>
            <span className="flex items-center justify-end gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="row"
                    size="icon-xs"
                    onClick={() => {
                      setRestartTarget(m);
                      setRestartOpen(true);
                    }}
                    disabled={!m.online}
                    aria-label={`restart ${m.name}`}
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{m.online ? 'restart machine' : 'machine is offline'}</p>
                </TooltipContent>
              </Tooltip>
              {/* cancelling needs only this site, so a pending move keeps its button */}
              {(targetSites.length > 0 || m.pendingMove) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="row"
                      size="icon-xs"
                      onClick={() => {
                        if (m.pendingMove) void handleCancelMove(m);
                        else setMoveTarget(m);
                      }}
                      disabled={m.pendingMove?.status === 'switching' || moveBusy}
                      aria-label={m.pendingMove ? `cancel move of ${m.name}` : `move ${m.name}`}
                    >
                      {m.pendingMove ? <X className="h-3.5 w-3.5" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {m.pendingMove?.status === 'switching'
                        ? 'switching sites now'
                        : m.pendingMove
                          ? 'cancel the move'
                          : 'move to another site'}
                    </p>
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="row-destructive"
                    size="icon-xs"
                    onClick={() => setRemoveTarget(m)}
                    aria-label={`remove ${m.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>remove machine from site</p>
                </TooltipContent>
              </Tooltip>
            </span>
          </li>
        ))}
      </ul>

      <MachinePowerConfirm
        action="restart"
        open={restartOpen}
        onOpenChange={setRestartOpen}
        machineName={restartTarget?.name ?? ''}
        guard={restartTarget ? activeHoursGuardOf({ ...restartTarget, agent_version: restartTarget.agentVersion }) : null}
        sending={power.sending}
        onConfirm={(options) => void handleConfirmRestart(options)}
      />

      {/* Remove confirmation — the shared dialog the dashboard uses. Active-
          deployment data isn't loaded in this panel, so that pre-check is
          left false here; the server remains the authority on removal. */}
      {removeTarget && (
        <RemoveMachineDialog
          open={removeTarget !== null}
          onOpenChange={(o) => !o && setRemoveTarget(null)}
          machineId={removeTarget.id}
          machineName={removeTarget.name}
          isOnline={removeTarget.online}
          hasActiveDeployments={false}
          isRemoving={removing}
          onConfirmRemove={handleConfirmRemove}
        />
      )}

      {moveTarget && (
        <MoveMachineDialog
          open={moveTarget !== null}
          onOpenChange={(o) => !o && setMoveTarget(null)}
          machine={moveTarget}
          sourceSite={{ id: siteId, name: siteName }}
          targetSites={targetSites}
          onMoved={() => void fetchMachines()}
        />
      )}
    </>
  );
}
