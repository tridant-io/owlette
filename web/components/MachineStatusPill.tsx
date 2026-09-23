'use client';

import { useEffect, useState } from 'react';
import { Power, RotateCw, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MachineStatusPillProps {
  online: boolean;
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — TARGET restart time (when the OS will actually restart). Field name kept as the agent-written wire contract.
  shutdownScheduledAt?: number;  // Unix seconds — TARGET shutdown time
  onCancel?: () => Promise<void>;
  isSiteAdmin?: boolean;
}

const CANCEL_LOCKOUT_THRESHOLD = 5; // Hide cancel in final 5s — Windows shutdown /a is unreliable

function formatMMSS(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function MachineStatusPill({
  online,
  rebooting,
  shuttingDown,
  rebootScheduledAt,
  shutdownScheduledAt,
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

  useEffect(() => {
    if (!isActive) return;
    // No sync setNow before the interval — trips react-hooks/set-state-in-effect. `now` starts at
    // the mount value and the first tick catches up within 1s.
    const interval = setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // Derived, so it auto-clears when the parent flips rebooting/shuttingDown back to false.
  const [userCancelling, setUserCancelling] = useState(false);
  const cancelling = isActive && userCancelling;

  // Idle. Online is the boring case, so it's a dot — only offline gets a labelled pill.
  if (!isActive) {
    return online ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 select-none cursor-help"
            aria-label="online"
            data-testid="machine-status-online"
          />
        </TooltipTrigger>
        <TooltipContent>
          <p>online</p>
        </TooltipContent>
      </Tooltip>
    ) : (
      <Badge className="text-xs select-none bg-red-600 text-white">offline</Badge>
    );
  }

  // Active: pulsing icon pill + countdown. scheduledAt is the TARGET instant in UNIX SECONDS,
  // written by the agent for scheduled restarts (announce phase) and dashboard-initiated ones.
  const remaining = scheduledAt
    ? Math.max(0, scheduledAt - now)
    : null;

  // Legacy/missing timestamp → icon-only pulsing pill.
  if (remaining === null) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 text-white animate-pulse px-1.5"
        title={actionLabel}
        aria-label={actionLabel}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
      </Badge>
    );
  }

  if (cancelling) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 text-white px-1.5"
        title="cancelling"
        aria-label="cancelling"
      >
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
      </Badge>
    );
  }

  const canCancel = isSiteAdmin && !!onCancel && remaining > CANCEL_LOCKOUT_THRESHOLD;

  // Final 5s, non-admin, or no cancel handler: no interaction.
  if (!canCancel) {
    return (
      <Badge
        role="img"
        className="text-xs select-none bg-red-600 text-white animate-pulse px-1 tabular-nums"
        title={actionLabel}
        aria-label={`${actionLabel}, ${formatMMSS(remaining)} remaining`}
      >
        <ActionIcon className="h-3 w-3" aria-hidden="true" />
        {formatMMSS(remaining)}
      </Badge>
    );
  }

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setUserCancelling(true);
    try {
      await onCancel!();
    } catch {
      setUserCancelling(false);
    }
  };

  return (
    <Badge
      asChild
      className="text-xs select-none bg-red-600 hover:bg-red-700 text-white animate-pulse cursor-pointer p-0 tabular-nums"
    >
      <button
        type="button"
        onClick={handleClick}
        title="click to cancel"
        aria-label={`${actionLabel}, ${formatMMSS(remaining)} remaining — click to cancel`}
        data-testid="machine-status-cancel-pill"
        className="group relative px-1 py-0.5"
      >
        <ActionIcon className="h-3 w-3 group-hover:invisible" aria-hidden="true" />
        <span className="group-hover:invisible">{formatMMSS(remaining)}</span>
        <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100">
          cancel
        </span>
      </button>
    </Badge>
  );
}
