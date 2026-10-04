'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface RemoveMachineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineId: string;
  machineName: string;
  isOnline: boolean;
  hasActiveDeployments: boolean;
  isRemoving: boolean;
  onConfirmRemove: () => void;
}

export function RemoveMachineDialog({
  open,
  onOpenChange,
  machineName,
  isOnline,
  hasActiveDeployments,
  isRemoving,
  onConfirmRemove,
}: RemoveMachineDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-danger" />
            remove machine from site
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            this action will permanently remove <span className="font-mono text-foreground">{machineName}</span> from this site.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Active Deployment Warning (Blocks Removal) */}
          {hasActiveDeployments && (
            <Alert className="border-danger-border bg-danger-surface">
              <AlertTriangle className="h-4 w-4 text-danger" />
              <AlertDescription className="text-danger text-sm ml-2">
                this machine has active deployments in progress. please wait for them to complete before removing the machine.
              </AlertDescription>
            </Alert>
          )}

          {/* Online Machine Warning */}
          {isOnline && !hasActiveDeployments && (
            <Alert className="border-warning-border bg-warning-surface">
              <AlertTriangle className="h-4 w-4 text-warning" />
              <AlertDescription className="text-warning text-sm ml-2">
                this machine is currently online. the owlette agent will detect the removal and stop syncing automatically.
              </AlertDescription>
            </Alert>
          )}

          {/* Main Warning */}
          <div className="rounded-lg border border-border bg-background p-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              the following will happen:
            </p>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
              <li>all machine data will be deleted from Firestore</li>
              <li>process configurations will be removed</li>
              <li>command history will be cleared</li>
              <li>the owlette agent will be deregistered</li>
            </ul>
          </div>

          {/* Reinstall Notice */}
          <div className="rounded-lg border border-accent-cyan/20 bg-accent-cyan/10 p-4">
            <p className="text-sm text-accent-cyan">
              to add this machine back to a site, you will need to re-run the owlette installer and pair it again using the 3-word phrase shown during install.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isRemoving}
            className="bg-secondary border border-border cursor-pointer disabled:cursor-not-allowed"
          >
            cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirmRemove}
            disabled={hasActiveDeployments || isRemoving}
            className="cursor-pointer disabled:cursor-not-allowed"
          >
            {isRemoving ? 'removing...' : 'remove machine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
