'use client';

import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { useMachines, type RestartSchedule } from '@/hooks/useFirestore';
import { toast } from '@/lib/toast';

interface ApplyScheduleToMachinesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  /** The machine the user is editing — pre-checked + disabled (saved by the parent dialog). */
  currentMachineId: string;
  /** The schedule to apply to other machines. */
  schedule: RestartSchedule;
}

/**
 * Bulk-apply modal for restart schedules. Lets the operator copy the current
 * schedule to many machines at once. Mirrors DeploymentDialog's checkbox-list
 * pattern. Per-machine `Promise.all` writes — no batch, since each write is
 * an independent setDoc with merge.
 */
export default function ApplyScheduleToMachinesDialog({
  open,
  onOpenChange,
  siteId,
  currentMachineId,
  schedule,
}: ApplyScheduleToMachinesDialogProps) {
  // Mount the body only while open so useState seeds fresh initial selection
  // each time the dialog opens — cleaner than a sync setState in an effect
  // (which violates react-hooks/set-state-in-effect).
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-md">
        {open && (
          <ApplyScheduleToMachinesDialogBody
            onOpenChange={onOpenChange}
            siteId={siteId}
            currentMachineId={currentMachineId}
            schedule={schedule}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApplyScheduleToMachinesDialogBody({
  onOpenChange,
  siteId,
  currentMachineId,
  schedule,
}: Omit<ApplyScheduleToMachinesDialogProps, 'open'>) {
  const { machines, updateRestartSchedule } = useMachines(siteId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set([currentMachineId]));
  const [applying, setApplying] = useState(false);

  const otherMachines = useMemo(
    () => machines.filter(m => m.machineId !== currentMachineId),
    [machines, currentMachineId]
  );
  const otherCount = otherMachines.length;
  const otherSelectedCount = useMemo(
    () => Array.from(selected).filter(id => id !== currentMachineId).length,
    [selected, currentMachineId]
  );
  const allOthersSelected = otherSelectedCount === otherCount && otherCount > 0;

  const toggleMachine = (machineId: string) => {
    if (machineId === currentMachineId) return; // can't toggle current
    const next = new Set(selected);
    if (next.has(machineId)) next.delete(machineId);
    else next.add(machineId);
    setSelected(next);
  };

  const toggleAllOthers = () => {
    const next = new Set<string>([currentMachineId]);
    if (!allOthersSelected) {
      otherMachines.forEach(m => next.add(m.machineId));
    }
    setSelected(next);
  };

  const handleApply = async () => {
    const targets = Array.from(selected).filter(id => id !== currentMachineId);
    if (targets.length === 0) {
      toast.error('select at least one machine to apply to');
      return;
    }

    setApplying(true);
    const results = await Promise.allSettled(
      targets.map(machineId => updateRestartSchedule(machineId, schedule))
    );

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.length - successCount;

    if (failCount === 0) {
      toast.success(`restart schedule applied to ${successCount} machine${successCount > 1 ? 's' : ''}`);
      onOpenChange(false);
    } else if (successCount === 0) {
      toast.error(`failed to apply schedule to all ${failCount} machine${failCount > 1 ? 's' : ''}`);
    } else {
      toast.warning(`applied to ${successCount}, failed on ${failCount}`);
      onOpenChange(false);
    }
    setApplying(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>apply restart schedule to...</DialogTitle>
        <DialogDescription className="text-muted-foreground text-pretty">
          this will overwrite the restart schedule on the selected machines.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-2 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {otherSelectedCount} of {otherCount} selected
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={toggleAllOthers}
            disabled={otherCount === 0}
            className="bg-secondary border-border hover:bg-accent text-xs"
          >
            {allOthersSelected ? 'deselect all' : 'select all'}
          </Button>
        </div>

        <div className="border border-border rounded-md bg-background/50 max-h-72 overflow-y-auto divide-y divide-border">
          {machines.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-4">no machines available</p>
          ) : (
            machines.map((machine) => {
              const isCurrent = machine.machineId === currentMachineId;
              const isChecked = selected.has(machine.machineId);
              // a label row: the whole row toggles the checkbox and names it
              return (
                <label
                  key={machine.machineId}
                  className={`flex items-center justify-between p-2 ${
                    isCurrent ? 'opacity-60' : 'hover:bg-secondary cursor-pointer'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleMachine(machine.machineId)}
                      disabled={isCurrent}
                      className="cursor-pointer"
                    />
                    <span className="text-foreground text-sm">{machine.machineId}</span>
                    {isCurrent && (
                      <span className="text-[10px] text-muted-foreground">(current)</span>
                    )}
                  </span>
                  <Badge className={`text-xs ${machine.online ? 'bg-green-600' : 'bg-red-600'}`}>
                    {machine.online ? 'online' : 'offline'}
                  </Badge>
                </label>
              );
            })
          )}
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={applying}
          className="bg-secondary border border-border cursor-pointer"
        >
          cancel
        </Button>
        <Button
          type="button"
          onClick={handleApply}
          disabled={applying || otherSelectedCount === 0}
          className="bg-cyan-600 hover:bg-cyan-700"
        >
          {applying ? 'applying...' : `apply to ${otherSelectedCount}`}
        </Button>
      </DialogFooter>
    </>
  );
}
