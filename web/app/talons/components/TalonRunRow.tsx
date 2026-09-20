'use client';

/**
 * One row of a talon's execution history:
 *   stateIcon | trigger / verdict summary | outputs | duration | when
 *
 * Status icons deliberately reuse the deployments page's vocabulary so a green check, red
 * cross and cyan spinner mean the same on both surfaces. `skipped` reads as `cancelled`
 * (orange) and `missed` as `partial` (yellow) — "did not happen", not "failed".
 *
 * A delayed event trigger also writes non-execution crumbs into the same collection:
 * `pending` while it waits out its delay, `fired` once it hands off.
 */

import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  MinusCircle,
  PlayCircle,
  XCircle,
} from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import {
  describeTalonDisabledReason,
  type TalonRunCondition,
  type TalonRunOutput,
  type TalonTimestamp,
} from '@/lib/talons/types';

/** Everything past the id is optional on purpose: these stream straight out of Firestore, so
 * an older engine build's record — or a mid-write one missing `completedAt` — must render. */
export interface TalonRunListItem {
  id: string;
  talonId?: string;
  talonName?: string;
  triggerType?: string | null;
  triggerSummary?: string | null;
  machineId?: string | null;
  machineName?: string | null;
  status?: string | null;
  startedAt?: TalonTimestamp | null;
  completedAt?: TalonTimestamp | null;
  durationMs?: number | null;
  condition?: TalonRunCondition | null;
  outputs?: TalonRunOutput[] | null;
  chatId?: string | null;
  error?: string | null;
  /** Set when this run is the one that switched the talon off. */
  disabledReason?: string | null;
  manual?: boolean;
}

interface TalonRunRowProps {
  run: TalonRunListItem;
}

/** Milliseconds out of any timestamp shape Firestore or the api can hand us. */
function timestampToMs(ts: TalonTimestamp | null | undefined): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const value = ts as {
    toMillis?: () => number;
    seconds?: number;
    _seconds?: number;
  };
  if (typeof value.toMillis === 'function') {
    try {
      return value.toMillis();
    } catch {
      return null;
    }
  }
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  return null;
}

/** `just now` / `12m ago` / `3h ago` / `2d ago`, then an absolute date. */
export function formatRelative(ts: TalonTimestamp | null | undefined): string {
  const ms = timestampToMs(ts);
  if (ms === null) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** `840ms` / `4.2s` / `3m 5s`. */
function formatDuration(run: TalonRunListItem): string {
  const explicit = typeof run.durationMs === 'number' ? run.durationMs : null;
  const startedMs = timestampToMs(run.startedAt);
  const completedMs = timestampToMs(run.completedAt);
  const ms =
    explicit ?? (startedMs !== null && completedMs !== null ? completedMs - startedMs : null);
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/** Shared run-status glyph, exported so the `last run` column matches the history it expands
 * into. */
export function talonStatusIcon(status: string | null | undefined) {
  switch (status) {
    case 'succeeded':
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3.5 w-3.5 text-red-500" />;
    case 'skipped':
      return <MinusCircle className="h-3.5 w-3.5 text-orange-500" />;
    case 'missed':
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />;
    case 'running':
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-cyan" />;
    // Deferral crumbs: `pending` is still counting down (live clock, not the muted "never
    // run" default); `fired` handed off to a real run that carries the outcome.
    case 'pending':
      return <Clock className="h-3.5 w-3.5 text-accent-cyan" />;
    case 'fired':
      return <PlayCircle className="h-3.5 w-3.5 text-accent-cyan" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

/** Why an operator should care that a run never fired. */
const STATUS_TOOLTIP: Record<string, string> = {
  missed: 'fired too late — skipped for safety',
  skipped: 'the run was gated before its outputs ran',
  pending: 'waiting out the delay before it runs',
  fired: 'the delay elapsed — the run it started is listed separately',
};

function outputsSummary(outputs: TalonRunOutput[]): {
  label: string;
  detail: string;
  failed: boolean;
} {
  const sent = outputs.filter((output) => output.status === 'sent').length;
  const failed = outputs.some((output) => output.status === 'failed');
  const detail = outputs
    .map((output) => {
      const suffix = output.error ?? output.detail;
      return `${output.type}: ${output.status}${suffix ? ` — ${suffix}` : ''}`;
    })
    .join('\n');
  return { label: `${sent}/${outputs.length} sent`, detail, failed };
}

export function TalonRunRow({ run }: TalonRunRowProps) {
  const status = run.status ?? 'running';
  const outputs = run.outputs ?? [];
  const condition = run.condition;
  const isVisualCheck = condition?.type === 'visual_check';
  const summary = run.triggerSummary || run.triggerType || 'talon run';
  const statusTooltip = STATUS_TOOLTIP[status];
  const outputSummary = outputs.length > 0 ? outputsSummary(outputs) : null;
  // Outranks `error` here: the raw error is a diagnostic, this is the sentence that explains
  // why the talon stopped running at all.
  const disabledReason = describeTalonDisabledReason(run.disabledReason);

  return (
    <div
      data-testid="talon-run-row"
      className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/30"
    >
      {statusTooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex-shrink-0" aria-label={status}>
              {talonStatusIcon(status)}
            </span>
          </TooltipTrigger>
          <TooltipContent>{statusTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="flex-shrink-0" aria-label={status}>
          {talonStatusIcon(status)}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <span className="block truncate text-foreground">
          {summary}
          {run.machineName || run.machineId ? (
            <span className="text-muted-foreground"> · {run.machineName || run.machineId}</span>
          ) : null}
        </span>
        {disabledReason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="talon-run-disabled-reason"
                className="block truncate text-amber-600 dark:text-amber-400"
              >
                talon switched off — {disabledReason}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md whitespace-pre-wrap">
              {run.error ?? `talon switched off — ${disabledReason}`}
            </TooltipContent>
          </Tooltip>
        ) : isVisualCheck && condition ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={`block truncate ${
                  condition.verdict === 'fail' ? 'text-red-400' : 'text-muted-foreground'
                }`}
              >
                verdict: {condition.verdict}
                {condition.reason ? ` — ${condition.reason}` : ''}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-md whitespace-pre-wrap">
              {condition.reason ?? `visual check ${condition.verdict}`}
            </TooltipContent>
          </Tooltip>
        ) : run.error ? (
          <TruncatedText text={run.error} className="block text-muted-foreground" />
        ) : null}
      </div>

      {run.chatId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href={`/hoot/${encodeURIComponent(run.chatId)}`}
              className="flex flex-shrink-0 items-center gap-1 text-accent-cyan hover:underline"
            >
              <MessageSquare className="h-3 w-3" />
              view hoot chat
            </Link>
          </TooltipTrigger>
          <TooltipContent>open the hoot conversation this run started</TooltipContent>
        </Tooltip>
      ) : null}

      {outputSummary ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`w-20 flex-shrink-0 text-right tabular-nums ${
                outputSummary.failed ? 'text-red-400' : 'text-muted-foreground'
              }`}
            >
              {outputSummary.label}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap">
            {outputSummary.detail}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="w-20 flex-shrink-0 text-right text-muted-foreground">no outputs</span>
      )}

      <span className="w-16 flex-shrink-0 text-right tabular-nums text-muted-foreground">
        {formatDuration(run)}
      </span>
      <span className="w-20 flex-shrink-0 text-right text-muted-foreground">
        {formatRelative(run.startedAt)}
      </span>
    </div>
  );
}
