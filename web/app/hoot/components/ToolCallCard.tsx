'use client';

import React, { useState } from 'react';
import { ChevronRight, Wrench, CheckCircle2, AlertCircle, Loader2, ShieldAlert, Ban, Check } from 'lucide-react';
import { getToolByName } from '@/lib/mcp-tools';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CopyButton } from './CopyButton';

/**
 * How many machines an approval prompt spells out before it collapses the rest
 * into a count. One or two are named outright; past that the count leads, so the
 * reader sees the blast radius before the list.
 */
const APPROVAL_IDS_SHOWN = 5;

/**
 * `kiosk-01` | `kiosk-01 and kiosk-02` | `7 machines: a, b, c, d, e and 2 more`,
 * or `every machine in this site (7 reachable)` when the turn asked for the
 * dynamic "all machines" rather than a chosen list.
 *
 * That distinction is the point: a named seven and the whole site can resolve to
 * the same seven ids, and "7 machines" reads like a selection either way. On a
 * prompt authorising a privileged command, the reader needs to know the set was
 * everything.
 *
 * NOT "every online machine (7)": `machineIds` is what the turn resolved to,
 * which drops offline machines AND online ones with hoot switched off. On a site
 * with eight machines online and hoot off on one, that phrasing asserts the seven
 * ARE every online machine, which is false — and false in exactly the place this
 * label exists to be precise. "reachable" is the honest word for the count, and
 * naming the SITE (not "online") is what carries the whole-site scope.
 *
 * A dynamic target that resolves to ONE machine is still named — the turn ran the
 * single-machine path, and the phrase would be a grander way of saying `kiosk-01`.
 */
function formatApprovalTargets(machineIds: string[], dynamic = false): string {
  if (machineIds.length === 1) return machineIds[0];
  if (dynamic) return `every machine in this site (${machineIds.length} reachable)`;
  if (machineIds.length === 2) return `${machineIds[0]} and ${machineIds[1]}`;
  const shown = machineIds.slice(0, APPROVAL_IDS_SHOWN);
  const rest = machineIds.length - shown.length;
  const names = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
  return `${machineIds.length} machines: ${names}`;
}

interface ToolCallCardProps {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isLoading?: boolean;
  /** Tier-3 human-in-the-loop gate; absent for tier-1/2 and executed calls. */
  approvalState?: 'requested' | 'denied';
  /**
   * FALLBACK for where the tool will run, e.g. a machine name or "all machines" —
   * used only for turns with no per-turn metadata (chats written before hoot
   * recorded a target per turn). `approvalTargetMachineIds` wins over it.
   */
  approvalTargetLabel?: string;
  /**
   * The machines THIS turn resolved to, from the assistant message's metadata.
   * It wins because the label follows the live header selector, which a loaded
   * chat can have pointed anywhere — approving on what the selector shows is how
   * a tier-3 call ends up credited to the wrong machine.
   */
  approvalTargetMachineIds?: string[];
  /** That turn asked for the dynamic "all machines" — see formatApprovalTargets. */
  approvalTargetDynamic?: boolean;
  onApprove?: () => void;
  onDeny?: () => void;
  /** Only set while executing with >=1 agent command dispatched (cancels the
   *  whole fan-out); server-side and undispatched calls get no cancel. */
  onCancel?: () => void;
  /** Cancel request in flight — disables the button. */
  cancelPending?: boolean;
}

export function ToolCallCard({
  toolName,
  args,
  result,
  isLoading,
  approvalState,
  approvalTargetLabel,
  approvalTargetMachineIds,
  approvalTargetDynamic,
  onApprove,
  onDeny,
  onCancel,
  cancelPending,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const toolDef = getToolByName(toolName);

  const hasError = result != null && typeof result === 'object' && !!(result as Record<string, unknown>).error;
  // Lowercase like every other label on this screen.
  const tierLabel = toolDef ? `tier ${toolDef.tier}` : '';
  const awaitingApproval = approvalState === 'requested';
  const denied = approvalState === 'denied';
  // An empty list falls back rather than erasing the target: a prompt that names
  // no machine at all is worse than one naming the selector's.
  const approvalTarget = approvalTargetMachineIds?.length
    ? formatApprovalTargets(approvalTargetMachineIds, approvalTargetDynamic)
    : approvalTargetLabel;

  // Prefer the uploaded Firebase URL; fall back to inline base64 if upload failed.
  let screenshotSrc: string | null = null;
  if (toolName === 'capture_screenshot' && result != null && typeof result === 'object' && !hasError) {
    const r = result as Record<string, unknown>;
    if (typeof r.url === 'string' && r.url) {
      screenshotSrc = r.url;
    } else if (typeof r.base64 === 'string' && r.base64) {
      screenshotSrc = `data:image/jpeg;base64,${r.base64}`;
    }
  }

  const statusIcon = awaitingApproval ? (
    <ShieldAlert className="h-4 w-4 text-warning" />
  ) : isLoading ? (
    <Loader2 className="h-4 w-4 text-accent-cyan animate-spin" />
  ) : denied ? (
    <Ban className="h-4 w-4 text-muted-foreground" />
  ) : hasError ? (
    <AlertCircle className="h-4 w-4 text-danger" />
  ) : (
    <CheckCircle2 className="h-4 w-4 text-success" />
  );

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={`my-2 rounded-lg border overflow-hidden ${
        awaitingApproval ? 'border-warning-border bg-warning-solid/5' : 'border-border bg-secondary/50'
      }`}
    >
      {/* Cancel is a sibling of the expand toggle, never nested inside it —
          nested interactive controls are an axe violation. */}
      <div className="flex items-stretch">
        <CollapsibleTrigger asChild>
          <button className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors cursor-pointer">
            {statusIcon}

            <Wrench className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />

            <span className="font-mono text-xs text-foreground truncate">{toolName}</span>

            {tierLabel && (
              /* `--muted-foreground` on `--accent` is 4.40:1 in dark — under the 4.5:1
                 axe enforces on /hoot, and this is 10px text, so it is held to the
                 normal-text threshold with no large-text relief. `--accent-foreground`
                 at 70% composites to rgb(178,194,208) for 6.22:1 while staying quieter
                 than the tool name beside it, which keeps the chip reading as metadata.
                 by day the same class lands at rgb(77,86,99) on the light accent, 5.87:1.
                 (work these ratios in gamma-encoded srgb, the space the browser blends
                 in: linear light flatters the dark blend to 7.87:1.) the accent fill
                 stays: against the card it is what makes the chip a chip, where
                 `--secondary` would all but vanish. */
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-foreground/70 flex-shrink-0">
                {tierLabel}
              </span>
            )}

            <span className="ml-auto flex items-center gap-1 text-muted-foreground flex-shrink-0">
              {awaitingApproval && <span className="text-xs text-warning">awaiting approval</span>}
              {denied && <span className="text-xs">denied</span>}
              {isLoading && !awaitingApproval && <span className="text-xs">executing...</span>}
              <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
            </span>
          </button>
        </CollapsibleTrigger>

        {isLoading && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelPending}
            title="cancel this tool call"
            className="flex-shrink-0 flex items-center gap-1 px-2.5 border-l border-border text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cancelPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Ban className="h-3.5 w-3.5" />
            )}
            cancel
          </button>
        )}
      </div>

      {/* Approval banner. Payload stays collapsed so it isn't duplicated here
          and in the expanded view. */}
      {awaitingApproval && (
        <div className="border-t border-warning-solid/30 px-3 py-2.5 space-y-2.5">
          <p className="text-xs text-foreground">
            hoot wants to run the privileged <span className="font-mono">{toolName}</span> tool
            {approvalTarget ? <> on <span className="font-medium">{approvalTarget}</span></> : null}. approve to continue, or expand to inspect the input.
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="default"
              disabled={submitting || !onApprove}
              onClick={() => { setSubmitting(true); onApprove?.(); }}
              className="h-8"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              approve
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={submitting || !onDeny}
              onClick={() => { setSubmitting(true); onDeny?.(); }}
              className="h-8"
            >
              <Ban className="h-3.5 w-3.5" />
              deny
            </Button>
          </div>
        </div>
      )}

      {screenshotSrc && (
        <a
          href={screenshotSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-t border-border bg-background"
          onClick={(e) => e.stopPropagation()}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={screenshotSrc}
            alt="Screenshot"
            className="w-full max-h-[480px] object-contain"
          />
        </a>
      )}

      <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
        {/* Border and padding live on this inner box: on the animated element
            they would hold it padding-tall at `height: 0`, and the slide would
            end in a jump. */}
        <div className="border-t border-border px-3 py-2 space-y-2">
          {Object.keys(args).length > 0 && (
            <div>
              <div className="flex items-center">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  input
                </span>
                <CopyButton value={JSON.stringify(args, null, 2)} className="ml-2" />
              </div>
              <pre className="mt-1 text-xs font-mono text-foreground bg-background rounded p-2 overflow-x-auto max-h-32">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {result != null && (() => {
            // Strip the base64 blob — already rendered above, unreadable as JSON.
            let displayResult: unknown = result;
            if (screenshotSrc && typeof result === 'object') {
              const { base64: _b64, ...rest } = result as Record<string, unknown>;
              void _b64;
              displayResult = rest;
            }
            const resultStr = typeof displayResult === 'string'
              ? displayResult
              : JSON.stringify(displayResult, null, 2);
            return (
              <div>
                <div className="flex items-center">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    output
                  </span>
                  <CopyButton value={resultStr} className="ml-2" />
                </div>
                <pre
                  className={`mt-1 text-xs font-mono rounded p-2 overflow-x-auto max-h-64 ${
                    hasError
                      ? 'text-danger bg-danger-surface'
                      : 'text-foreground bg-background'
                  }`}
                >
                  {resultStr}
                </pre>
              </div>
            );
          })()}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
