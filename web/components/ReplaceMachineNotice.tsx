'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';

/**
 * The confirmation every authorize surface shows before pairing a machine that
 * is already on the site: the authorize route refuses it until the request
 * names the machine.
 */
export function ReplaceMachineNotice({
  machineId,
  busy,
  onConfirm,
  onCancel,
}: {
  machineId: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <InlineNotice data-testid="replace-machine-notice">
      <p className="text-sm text-foreground">
        <span className="break-all font-mono">{machineId}</span> is already on this site. replace it
        only if you are reinstalling it.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onConfirm} disabled={busy} className="cursor-pointer">
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              authorizing...
            </>
          ) : (
            'replace machine'
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy} className="cursor-pointer">
          cancel
        </Button>
      </div>
    </InlineNotice>
  );
}
