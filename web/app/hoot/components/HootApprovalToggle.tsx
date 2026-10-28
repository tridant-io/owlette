'use client';

import React, { useState } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useHootApprovalSetting } from '@/hooks/useHootApprovalSetting';

interface HootApprovalToggleProps {
  siteId: string;
}

/**
 * Site-wide admin toggle for the tier-3 approval gate. When ON (default),
 * privileged tool calls pause for in-chat approval before they run. Turning it
 * OFF drops that gate, and on the PUBLIC conversations API it re-opens the
 * lower-latency local hoot path (`lib/hootStream.server.ts:156-162`). The
 * dashboard chat is unaffected either way: it always runs server-side through
 * `lib/hoot/turnRunner.server.ts`.
 */
export function HootApprovalToggle({ siteId }: HootApprovalToggleProps) {
  const { requireApproval } = useHootApprovalSetting(siteId);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const setValue = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/hoot-settings`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requireTier3Approval: next }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'Failed to update approval setting');
      }
    } catch (err) {
      console.error('Failed to update hoot approval setting:', err);
    } finally {
      setBusy(false);
    }
  };

  const handleClick = () => {
    // Disabling the gate weakens safety — confirm. Enabling is one click.
    if (requireApproval) setConfirmOpen(true);
    else void setValue(true);
  };

  const label = requireApproval ? 'approval required' : 'approval off';
  const tooltip = requireApproval
    ? 'privileged (tier-3) actions require in-chat approval — click to disable site-wide'
    : 'privileged (tier-3) actions run without approval — click to require approval site-wide';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleClick}
            disabled={busy}
            aria-label={tooltip}
            aria-pressed={requireApproval}
            // the hover tint is lighter by day: the night's 20% costs the light
            // status text too much contrast.
            className={`flex items-center justify-center gap-1.5 size-8 md:size-auto md:px-2 md:py-1 rounded border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              requireApproval
                ? 'border-warning-border bg-warning-surface text-warning hover:bg-warning-solid/10 dark:hover:bg-warning-solid/20'
                : 'border-border bg-secondary text-muted-foreground hover:bg-accent'
            }`}
          >
            {requireApproval ? (
              <ShieldCheck className="h-4 w-4 md:h-3.5 md:w-3.5" />
            ) : (
              <ShieldOff className="h-4 w-4 md:h-3.5 md:w-3.5" />
            )}
            <span className="hidden md:inline text-xs font-medium">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="disable tier-3 approval site-wide?"
        description={
          'privileged tool calls (run_powershell, execute_script, restart, etc.) will run immediately without in-chat approval for everyone on this site. the lower-latency local hoot path also becomes available again on the public conversations API; the dashboard chat is unaffected. only turn this off if the approval prompts are getting in the way.'
        }
        confirmText="disable approval"
        cancelText="cancel"
        onConfirm={() => setValue(false)}
        variant="destructive"
      />
    </>
  );
}
