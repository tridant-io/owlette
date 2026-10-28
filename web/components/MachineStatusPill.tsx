'use client';

import { useEffect, useState } from 'react';
import { Clock, Power, RotateCw, Loader2, X, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { machineClockAt } from '@/lib/activeHours';
import { cn } from '@/lib/utils';

interface MachineStatusPillProps {
  online: boolean;
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — TARGET restart time (when the OS will actually restart). Field name kept as the agent-written wire contract.
  shutdownScheduledAt?: number;  // Unix seconds — TARGET shutdown time
  rebootDeferredUntil?: number;  // Unix seconds — a restart the agent holds until active hours end
  /** the machine's IANA zone, which a held restart's time reads in. */
  machineTimezone?: string;
  /** the list's fixed 72px status cell: a held restart shows its time without the words. */
  compact?: boolean;
  onCancel?: () => Promise<void>;
  isSiteAdmin?: boolean;
}

const CANCEL_LOCKOUT_THRESHOLD = 5; // Hide cancel in final 5s — Windows shutdown /a is unreliable

const COUNTDOWN_FILL = 'bg-danger-solid text-danger-solid-foreground';
// a held restart is hours away and waits on purpose: amber and still, not the countdown's red pulse
const DEFERRED_FILL = 'bg-warning-solid text-warning-solid-foreground';

function formatMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function CancellingPill({ fill }: { fill: string }) {
  return (
    <Badge
      role="img"
      className={cn('text-xs select-none px-1.5', fill)}
      title="cancelling"
      aria-label="cancelling"
    >
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
    </Badge>
  );
}

/** The pill as its own cancel button: hovering swaps its text for "cancel". */
function CancelPill({
  icon: Icon,
  text,
  label,
  title,
  className,
  testId,
  onClick,
}: {
  icon: LucideIcon;
  text: React.ReactNode;
  label: string;
  title: string;
  className: string;
  testId: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <Badge asChild className={cn('text-xs select-none cursor-pointer p-0 tabular-nums', className)}>
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-label={`${label} — click to cancel`}
        data-testid={testId}
        className="group relative px-1 py-0.5 pointer-coarse:min-h-6"
      >
        {/* A touch screen has no hover to reveal "cancel", so there the × takes
            the icon's place and says the pill is a cancel button. */}
        <Icon className="h-3 w-3 group-hover:invisible pointer-coarse:hidden" aria-hidden="true" />
        <X className="hidden h-3 w-3 group-hover:invisible pointer-coarse:block" aria-hidden="true" />
        <span className="group-hover:invisible">{text}</span>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          cancel
        </span>
      </button>
    </Badge>
  );
}

export function MachineStatusPill({
  online,
  rebooting,
  shuttingDown,
  rebootScheduledAt,
  shutdownScheduledAt,
  rebootDeferredUntil,
  machineTimezone,
  compact,
  onCancel,
  isSiteAdmin,
}: MachineStatusPillProps) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Active on EITHER the boolean flag or a future scheduledAt, so the countdown appears the moment
  // the listener sees the doc rather than waiting for the flag to round-trip separately.
  const hasUpcomingRestart = !!(rebootScheduledAt && rebootScheduledAt > now);
  const hasUpcomingShutdown = !!(shutdownScheduledAt && shutdownScheduledAt > now);
  const showRestartMode = !!rebooting || hasUpcomingRestart;
  // The agent sets `shuttingDown` before the OS shutdown and can never clear it (box is off), so
  // "latch set + offline" means completed — fall through to the offline pill instead of pulsing
  // forever. A still-future scheduled shutdown keeps its countdown either way. Restart stays
  // active across the reboot gap on purpose: its terminal state is back-online.
  const showShutdownMode = (!!shuttingDown && online) || hasUpcomingShutdown;
  const isActive = showRestartMode || showShutdownMode;
  const scheduledAt = showRestartMode ? rebootScheduledAt : showShutdownMode ? shutdownScheduledAt : undefined;
  const actionLabel = showShutdownMode ? 'shutting down' : 'restarting';
  // The status column is a fixed 72px cell (list view is table-layout:fixed), so icon + countdown
  // rather than the full label, which would overflow into cpu. Words go on title/aria-label.
  const ActionIcon = showShutdownMode ? Power : RotateCw;
  // A held restart is a clock time, not a countdown: hours of MM:SS would read 360:00 and overflow
  // that cell. A countdown under way outranks it, and so does offline.
  const deferredUntil = !isActive && online ? rebootDeferredUntil : undefined;

  useEffect(() => {
    if (!isActive) return;
    // No sync setNow before the interval — trips react-hooks/set-state-in-effect. `now` starts at
    // the mount value and the first tick catches up within 1s.
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // The instant whose cancel is in flight. Keyed rather than a flag, so it clears itself when the
  // parent drops that restart, and a later one never opens on the spinner.
  const [cancellingAt, setCancellingAt] = useState<number | null>(null);

  const handleCancel = (target: number) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCancellingAt(target);
    try {
      await onCancel!();
    } catch {
      setCancellingAt(null);
    }
  };

  if (deferredUntil) {
    const { time, machineTime } = machineClockAt(deferredUntil, machineTimezone);
    const label = `restart at ${time} (${machineTime ? 'machine time' : 'UTC'})`;
    // a phone's card header has no more room than the list cell, so the words go there too
    const text = compact ? time : <><span className="hidden sm:inline">restart at </span>{time}</>;
    if (cancellingAt === deferredUntil) return <CancellingPill fill={DEFERRED_FILL} />;
    if (!isSiteAdmin || !onCancel) {
      return (
        <Badge
          role="img"
          className={cn('text-xs select-none px-1 tabular-nums', DEFERRED_FILL)}
          title={label}
          aria-label={label}
          data-testid="machine-status-deferred-pill"
        >
          <Clock className="h-3 w-3" aria-hidden="true" />
          {text}
        </Badge>
      );
    }
    return (
      <CancelPill
        icon={Clock}
        text={text}
        label={label}
        title={`${label} — click to cancel`}
        className={cn('hover:bg-warning-solid/85', DEFERRED_FILL)}
        testId="machine-status-deferred-pill"
        onClick={handleCancel(deferredUntil)}
      />
    );
  }

  // Idle. Online is the boring case, so it's a dot — only offline gets a labelled pill.
  if (!isActive) {
    return online ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            className="inline-block w-2.5 h-2.5 rounded-full bg-success select-none cursor-help"
            aria-label="online"
            data-testid="machine-status-online"
          />
        </TooltipTrigger>
        <TooltipContent>
          <p>online</p>
        </TooltipContent>
      </Tooltip>
    ) : (
      <Badge className="text-xs select-none bg-danger-solid text-danger-solid-foreground">offline</Badge>
    );
  }

  // Active: pulsing icon pill + countdown. scheduledAt is the TARGET instant in UNIX SECONDS,
  // written by the agent for scheduled restarts (announce phase) and dashboard-initiated ones.
  // Legacy/missing timestamp → icon-only pulsing pill.
  if (!scheduledAt) {
    return (
      <Badge
        role="img"
        className={cn('text-xs select-none animate-pulse px-1.5', COUNTDOWN_FILL)}
        title={actionLabel}
        aria-label={actionLabel}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
      </Badge>
    );
  }

  const remaining = Math.max(0, scheduledAt - now);

  if (cancellingAt === scheduledAt) return <CancellingPill fill={COUNTDOWN_FILL} />;

  const canCancel = isSiteAdmin && !!onCancel && remaining > CANCEL_LOCKOUT_THRESHOLD;

  // Final 5s, non-admin, or no cancel handler: no interaction.
  if (!canCancel) {
    return (
      <Badge
        role="img"
        className={cn('text-xs select-none animate-pulse px-1 tabular-nums', COUNTDOWN_FILL)}
        title={actionLabel}
        aria-label={`${actionLabel}, ${formatMMSS(remaining)} remaining`}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
        {formatMMSS(remaining)}
      </Badge>
    );
  }

  return (
    <CancelPill
      icon={ActionIcon}
      text={formatMMSS(remaining)}
      label={`${actionLabel}, ${formatMMSS(remaining)} remaining`}
      title="click to cancel"
      className={cn('hover:bg-danger-solid/85 animate-pulse', COUNTDOWN_FILL)}
      testId="machine-status-cancel-pill"
      onClick={handleCancel(scheduledAt)}
    />
  );
}
