'use client';

/**
 * The restart and shutdown confirm, shared by the machine context menu, the
 * card's approve button and the manage-sites machine list, plus the hook that
 * sends the command and reports what the agent did with it.
 *
 * Inside a guarded machine's active hours the agent refuses a command without
 * an override, and a refused restart still counts against its 5 s rate limit,
 * so the confirm offers the choice before the first request instead of
 * sending, being refused and retrying.
 */

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { ACTIVE_HOURS_NOTICE_CLASS, OverrideReasonField } from '@/components/OverrideReasonField';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCommandOutcome } from '@/hooks/useCommandResult';
import { useMinuteTick } from '@/hooks/useMinuteTick';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  describeActiveHours,
  insideActiveHoursNow,
  parseActiveHoursRefusal,
  POWER_COUNTDOWN_SECONDS,
  type ActiveHoursGuard,
  type PowerAction,
  type PowerCommandOptions,
  type PowerCommandSent,
} from '@/lib/activeHours';

export interface PowerSend {
  machineId: string;
  machineName: string;
  action: PowerAction;
  options: PowerCommandOptions;
  /** queues the command; resolves with its id where the caller can watch it. */
  run: (options: PowerCommandOptions) => Promise<PowerCommandSent | void>;
}

interface SentCommand extends PowerCommandSent {
  machineId: string;
  machineName: string;
  action: PowerAction;
}

function sentToast(action: PowerAction, machineName: string, options: PowerCommandOptions): void {
  if (action === 'restart' && options.when === 'after_active_hours') {
    toast.success(`${machineName} will restart when active hours end`, {
      description: 'owlette restarts it once they are over on the machine clock.',
    });
    return;
  }
  toast.success(`${action} command sent to ${machineName}`, {
    description: `it ${action === 'restart' ? 'restarts' : 'shuts down'} in ${POWER_COUNTDOWN_SECONDS} seconds unless cancelled.`,
  });
}

/**
 * Sends a restart or shutdown and watches its outcome. A failed one, an
 * active-hours refusal above all, takes back the countdown the dashboard drew
 * for it and says why.
 */
export function usePowerCommand(siteId: string) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SentCommand | null>(null);
  const outcome = useCommandOutcome(siteId, sent?.machineId ?? '', sent?.commandId ?? null);

  useEffect(() => {
    if (!sent || outcome?.status !== 'failed') return;
    sent.revertCountdown?.();
    const refusal = parseActiveHoursRefusal(outcome.error);
    if (refusal) {
      toast.error(`${sent.action} refused: inside active hours ${refusal.window}`, {
        description: refusal.endsAt
          ? `${sent.machineName}'s active hours end at ${refusal.endsAt}, machine time.`
          : `${sent.machineName} is inside its active hours.`,
      });
    } else {
      toast.error(`${sent.action} failed on ${sent.machineName}`, {
        description: outcome.error.replace(/^Error:\s*/, ''),
      });
    }
  }, [outcome, sent]);

  /** true once the command is queued. */
  const send = async ({ machineId, machineName, action, options, run }: PowerSend): Promise<boolean> => {
    setSending(true);
    try {
      const result = await run(options);
      setSent(result ? { ...result, machineId, machineName, action } : null);
      sentToast(action, machineName, options);
      return true;
    } catch (error: unknown) {
      toast.error(`failed to send ${action} command`, {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setSending(false);
    }
  };

  return { send, sending };
}

interface MachinePowerConfirmProps {
  action: PowerAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machineName: string;
  /** the active hours the machine's agent enforces (`activeHoursGuardOf`); null keeps the plain confirm. */
  guard?: ActiveHoursGuard | null;
  sending: boolean;
  onConfirm: (options: PowerCommandOptions) => void;
}

export function MachinePowerConfirm({
  action,
  open,
  onOpenChange,
  machineName,
  guard,
  sending,
  onConfirm,
}: MachinePowerConfirmProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border p-4 sm:p-6">
        {/* inside the content, which unmounts on close, so a reason never outlives the dialog */}
        <ConfirmBody
          action={action}
          machineName={machineName}
          guard={guard}
          sending={sending}
          onConfirm={onConfirm}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({
  action,
  machineName,
  guard,
  sending,
  onConfirm,
  onCancel,
}: Omit<MachinePowerConfirmProps, 'open' | 'onOpenChange'> & { onCancel: () => void }) {
  // re-reads the machine clock once a minute while the dialog is open
  useMinuteTick();
  const title = action === 'restart' ? `restart ${machineName}?` : `shutdown ${machineName}?`;
  const inside = guard ? insideActiveHoursNow(guard) : false;

  if (!guard || inside === false) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {action === 'restart'
              ? `this will restart the machine in ${POWER_COUNTDOWN_SECONDS} seconds. all running processes will be interrupted.`
              : `this will shut down the machine in ${POWER_COUNTDOWN_SECONDS} seconds. the machine will not automatically restart.`}{' '}
            you&apos;ll have {POWER_COUNTDOWN_SECONDS} seconds to cancel from the dashboard.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            cancel
          </Button>
          <Button variant="destructive" onClick={() => onConfirm({})} disabled={sending}>
            {sending ? 'sending...' : action === 'restart' ? 'restart' : 'shutdown'}
          </Button>
        </DialogFooter>
      </>
    );
  }

  const verb = action === 'restart' ? 'restart' : 'shut down';

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {/* null: the agent did not name its zone, so this clock can't tell; the agent still decides */}
        <p
          data-testid="active-hours-notice"
          className={cn('flex items-center gap-2 px-3 py-2 text-left text-sm text-warning', ACTIVE_HOURS_NOTICE_CLASS)}
        >
          <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
          {inside === null ? 'may be inside' : 'inside'} active hours ({describeActiveHours(guard.window)}, machine time)
        </p>
        <DialogDescription className="text-muted-foreground">
          owlette holds {action === 'restart' ? 'restarts' : 'shutdowns'} until they end. to {verb} now, give a
          reason; it is logged with your name.
        </DialogDescription>
      </DialogHeader>
      <OverrideReasonField
        confirmLabel={`${verb} now`}
        sending={sending}
        onCancel={onCancel}
        onConfirm={(override) => onConfirm({ override })}
      >
        {action === 'restart' && (
          <Button disabled={sending} onClick={() => onConfirm({ when: 'after_active_hours' })}>
            restart when active hours end
          </Button>
        )}
      </OverrideReasonField>
    </>
  );
}
