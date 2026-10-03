'use client';

import React, { useState } from 'react';
import {} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { Machine } from '@/hooks/useFirestore';
import { HootIcon } from '@/components/icons/HootIcon';

interface HootPowerToggleProps {
  siteId: string;
  machine: Machine;
}

export function HootPowerToggle({ siteId, machine }: HootPowerToggleProps) {
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const enabled = machine.cortexEnabled !== false;

  const handleConfirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machine.machineId)}/hoot-enabled`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !enabled }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'Failed to toggle hoot');
      }
    } catch (err) {
      console.error('Failed to toggle cortexEnabled:', err);
    } finally {
      setBusy(false);
    }
  };

  const label = enabled ? 'hoot active' : 'hoot inactive';
  const tooltip = enabled
    ? 'hoot active — click to disable tool calls on this machine'
    : 'hoot inactive — click to re-enable tool calls on this machine';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            aria-label={tooltip}
            aria-pressed={!enabled}
            // the hover tint is lighter by day: the night's 20% costs the light
            // status text too much contrast.
            className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
              enabled
                ? 'border-success-border bg-success-surface text-success hover:bg-success-solid/10 dark:hover:bg-success-solid/20'
                : 'border-warning-border bg-warning-surface text-warning hover:bg-warning-solid/10 dark:hover:bg-warning-solid/20'
            }`}
          >
            <HootIcon className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={enabled ? 'disable hoot on this machine?' : 'enable hoot on this machine?'}
        description={
          enabled
            ? `hoot tool calls will be blocked on "${machine.machineId}" until re-enabled. the agent will stay online for monitoring — only LLM-initiated actions (manual and autonomous) are paused.`
            : `hoot tool calls will resume on "${machine.machineId}". both manual chat and autonomous investigations will be able to execute tools on this machine again.`
        }
        confirmText={enabled ? 'disable hoot' : 'enable hoot'}
        cancelText="cancel"
        onConfirm={handleConfirm}
        variant={enabled ? 'destructive' : 'default'}
      />
    </>
  );
}
