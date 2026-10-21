'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Monitor, RotateCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/lib/toast';
import { formatRelativeTime } from '@/lib/timeUtils';
import { useMachineOperations } from '@/hooks/useMachineOperations';
import { RemoveMachineDialog } from '@/components/RemoveMachineDialog';

interface SiteMachine {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  /** keep screens awake as the agent reports it; null before 4.1.1. only `held` is read here. */
  displayAwake?: { held?: boolean } | null;
}

interface SiteMachinesListProps {
  siteId: string;
  /** Report the fetched machine count so the parent row can display it. */
  onCountLoaded?: (siteId: string, count: number) => void;
}

/**
 * Expanded machine list for one site row in the manage-sites dialog.
 *
 * Uses GET /api/sites/{siteId}/machines (admin-SDK, scope-checked server side)
 * rather than a client Firestore listener, so superadmins can inspect sites
 * they aren't members of without loosening rules. Mounted only while expanded,
 * so collapsing unmounts and re-expanding refetches.
 */
export function SiteMachinesList({ siteId, onCountLoaded }: SiteMachinesListProps) {
  const [machines, setMachines] = useState<SiteMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restartTarget, setRestartTarget] = useState<SiteMachine | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SiteMachine | null>(null);
  const { removeMachineFromSite, removing } = useMachineOperations(siteId);

  const fetchMachines = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/machines`);
      if (!response.ok) throw new Error(`failed to load machines (${response.status})`);
      const body = (await response.json()) as { machines: SiteMachine[] };
      setMachines(body.machines);
      onCountLoaded?.(siteId, body.machines.length);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'failed to load machines');
    }
  }, [siteId, onCountLoaded]);

  useEffect(() => {
    void fetchMachines();
  }, [fetchMachines]);

  const handleConfirmRestart = async () => {
    if (!restartTarget) return;
    setIsRestarting(true);
    try {
      // UI says "restart"; the wire verb deliberately stays "reboot".
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(restartTarget.id)}/commands`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': `machine-restart-${siteId}-${restartTarget.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          },
          body: JSON.stringify({ type: 'reboot_machine', params: { delay_seconds: 30 } }),
        },
      );
      if (!response.ok) throw new Error(`restart failed (${response.status})`);
      toast.success(`"${restartTarget.name}" will restart in ~30 seconds`);
      setRestartTarget(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'failed to send restart');
    } finally {
      setIsRestarting(false);
    }
  };

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await removeMachineFromSite(removeTarget.id);
      toast.success(`Machine "${removeTarget.name}" removed from site successfully!`);
      setRemoveTarget(null);
      await fetchMachines();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'failed to remove machine');
    }
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
            className="grid items-center gap-3 px-3 py-1.5"
            style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1.3fr) minmax(0,1fr) 64px' }}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${m.online ? 'bg-success' : 'bg-danger/70'}`}
              />
              <Monitor className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-foreground" title={m.name}>
                {m.name}
              </span>
              {m.displayAwake?.held && (
                <span className="shrink-0 text-[10px] text-muted-foreground">awake</span>
              )}
            </span>
            <span className={`min-w-0 truncate text-[11px] ${m.online ? 'text-success dark:text-success/90' : 'text-muted-foreground'}`}>
              {lastSeen(m)}
            </span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {m.agentVersion ? `v${m.agentVersion}` : '—'}
            </span>
            <span className="flex items-center justify-end gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRestartTarget(m)}
                    disabled={!m.online}
                    aria-label={`restart ${m.name}`}
                    className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-accent-cyan cursor-pointer disabled:cursor-not-allowed"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{m.online ? 'restart machine' : 'machine is offline'}</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoveTarget(m)}
                    aria-label={`remove ${m.name}`}
                    className="h-7 w-7 p-0 text-muted-foreground hover:bg-muted hover:text-danger cursor-pointer"
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

      {/* Restart confirmation */}
      <Dialog open={restartTarget !== null} onOpenChange={(o) => !o && setRestartTarget(null)}>
        <DialogContent className="border-border text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">restart machine</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              restart <span className="font-mono text-foreground">{restartTarget?.name}</span>? it will
              restart in about 30 seconds and every process on it will be interrupted. the agent
              reconnects automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRestartTarget(null)}
              disabled={isRestarting}
              className="bg-secondary border border-border cursor-pointer"
            >
              cancel
            </Button>
            <Button
              onClick={handleConfirmRestart}
              disabled={isRestarting}
              className="cursor-pointer"
            >
              <RotateCw className="h-4 w-4 mr-1" />
              {isRestarting ? 'sending…' : 'restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </>
  );
}
