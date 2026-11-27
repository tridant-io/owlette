'use client';

import { useState } from 'react';
import { AlertTriangle, ArrowRightLeft } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useMachineMove } from '@/hooks/useMachineMove';
import type { SiteMachine } from '@/hooks/useSiteMachines';
import { canFollowMove, MOVE_OFFLINE, MOVE_TOO_OLD } from '@/lib/machineMove';
import { toast } from '@/lib/toast';
import { SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

interface MoveMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machine: SiteMachine;
  sourceSite: { id: string; name: string };
  targetSites: { id: string; name: string }[];
  onMoved?: () => void;
}

export function MoveMachineDialog({
  open,
  onOpenChange,
  machine,
  sourceSite,
  targetSites,
  onMoved,
}: MoveMachineDialogProps) {
  const { requestMove, busy } = useMachineMove(sourceSite.id);
  const [targetSiteId, setTargetSiteId] = useState('');
  const [seededOpen, setSeededOpen] = useState(open);
  // each open starts with no site picked; the closing frames keep the pick
  if (open !== seededOpen) {
    setSeededOpen(open);
    if (open) setTargetSiteId('');
  }
  const target = targetSites.find((site) => site.id === targetSiteId);
  const canMove = canFollowMove(machine);

  const move = async () => {
    if (!target || !canMove || busy) return;
    try {
      await requestMove(machine.id, target.id);
      toast.success('move requested', {
        description: machine.online
          ? `${machine.name} moves to ${target.name} within seconds.`
          : `${machine.name} moves to ${target.name} when it is back online.`,
      });
      onMoved?.();
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error('could not move the machine', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <ArrowRightLeft className="h-5 w-5 text-accent-cyan" />
            move {machine.name}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            <span className="font-mono text-foreground">{machine.name}</span> leaves {sourceSite.name} and joins the
            site you pick, within seconds while it is online. it needs no restart and nobody at the machine. its
            processes come with it. its command history on {sourceSite.name} is deleted, and members limited to it
            here lose it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!canMove && (
            <Alert className="border-danger-border bg-danger-surface">
              <AlertTriangle className="h-4 w-4 text-danger" />
              <AlertDescription className="text-danger text-sm ml-2">
                {MOVE_TOO_OLD(machine.name, machine.agentVersion ?? 'unknown', SITE_MOVE_MIN_AGENT_VERSION)}
              </AlertDescription>
            </Alert>
          )}

          {canMove && !machine.online && (
            <Alert className="border-warning-border bg-warning-surface">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-sm ml-2">{MOVE_OFFLINE(machine.name)}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="move-machine-target">move to</Label>
            <Select value={target?.id ?? ''} onValueChange={setTargetSiteId} disabled={busy || !canMove}>
              <SelectTrigger id="move-machine-target" className="w-full border-border bg-secondary text-foreground">
                <SelectValue placeholder="pick a site" />
              </SelectTrigger>
              <SelectContent className="border-border bg-card">
                {targetSites.map((site) => (
                  <SelectItem key={site.id} value={site.id} className="text-foreground focus:text-foreground">
                    {site.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            cancel
          </Button>
          <Button onClick={() => void move()} disabled={!canMove || !target || busy}>
            {busy ? 'moving…' : 'move machine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
