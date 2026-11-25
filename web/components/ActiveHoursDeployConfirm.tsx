'use client';

/**
 * The confirm a deployment, or a retry of one, asks for when some of its
 * machines are inside active hours. A guarded agent refuses an install there,
 * before it closes any process, unless a person overrode it, so the dashboard
 * names those machines first and sends the person's reason with the request
 * as `active_hours_override`. The server puts it on every install command the
 * request queues, so the reason covers the whole request.
 */

import { Clock } from 'lucide-react';
import { ACTIVE_HOURS_NOTICE_CLASS, OverrideReasonField } from '@/components/OverrideReasonField';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  activeHoursGuardOf,
  describeActiveHours,
  insideActiveHoursNow,
  type ActiveHours,
} from '@/lib/activeHours';
import { cn } from '@/lib/utils';

export interface MachineInActiveHours {
  machineId: string;
  window: ActiveHours;
  /** null: the agent did not name its zone, so this clock can't tell; the agent still decides. */
  inside: true | null;
}

type GuardedMachine = Parameters<typeof activeHoursGuardOf>[0] & { machineId: string };

/** The chosen machines whose agent refuses an install now, or may: its clock is unknown here. */
export function machinesInActiveHours(
  machines: readonly GuardedMachine[],
  machineIds: Iterable<string>,
  now: Date = new Date(),
): MachineInActiveHours[] {
  const chosen = new Set(machineIds);
  const found: MachineInActiveHours[] = [];
  for (const machine of machines) {
    if (!chosen.has(machine.machineId)) continue;
    const guard = activeHoursGuardOf(machine);
    if (!guard) continue;
    const inside = insideActiveHoursNow(guard, now);
    if (inside !== false) found.push({ machineId: machine.machineId, window: guard.window, inside });
  }
  return found;
}

export type DeployConfirmAction = 'deploy' | 'retry';

interface ActiveHoursDeployConfirmProps {
  action: DeployConfirmAction;
  open: boolean;
  /** kept by the caller after close, so the list doesn't empty while the dialog fades out. */
  machines: readonly MachineInActiveHours[];
  onCancel: () => void;
  sending: boolean;
  onConfirm: (override: { reason: string }) => void;
}

export function ActiveHoursDeployConfirm({
  action,
  open,
  machines,
  onCancel,
  sending,
  onConfirm,
}: ActiveHoursDeployConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="border-border p-4 sm:p-6">
        {/* inside the content, which unmounts on close, so a reason never outlives the dialog */}
        <ConfirmBody
          action={action}
          machines={machines}
          sending={sending}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({
  action,
  machines,
  sending,
  onConfirm,
  onCancel,
}: Omit<ActiveHoursDeployConfirmProps, 'open'>) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{action} inside active hours?</DialogTitle>
        <DialogDescription className="text-muted-foreground">
          owlette refuses installs inside active hours (machine time), before closing any process. to {action}{' '}
          now, give a reason. it covers every machine in this {action === 'deploy' ? 'deployment' : 'retry'} and
          is logged with your name.
        </DialogDescription>
      </DialogHeader>
      <ul
        aria-label="machines inside active hours"
        className={cn('max-h-40 divide-y divide-warning-border/40 overflow-y-auto', ACTIVE_HOURS_NOTICE_CLASS)}
      >
        {machines.map((machine) => (
          <li key={machine.machineId} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-foreground">
              <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span className="truncate">{machine.machineId}</span>
            </span>
            <span className="shrink-0 text-xs text-warning">
              {machine.inside === null ? 'may be inside ' : ''}
              {describeActiveHours(machine.window)}
            </span>
          </li>
        ))}
      </ul>
      <OverrideReasonField
        confirmLabel={`${action} anyway`}
        sending={sending}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </>
  );
}
