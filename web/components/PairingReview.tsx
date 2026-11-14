'use client';

import { Loader2, Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReplaceMachineNotice } from '@/components/ReplaceMachineNotice';

/**
 * The machine a pairing phrase names, shown before anyone approves it, and the
 * approval: the replace confirmation for a machine already on the site, else
 * authorize. Fed by `useDeviceCodeAuthorize`'s `review`.
 */
export function PairingReview({
  review,
  busy,
  onAuthorize,
  onCancel,
  size,
}: {
  review: { machineId: string | null; existing: boolean };
  busy: boolean;
  onAuthorize: () => void;
  onCancel: () => void;
  size?: 'lg';
}) {
  const icon = size === 'lg' ? 'h-5 w-5 mr-2' : 'h-4 w-4 mr-2';
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">machine</p>
        <p className="break-all font-mono text-foreground" data-testid="add-machine-name">
          {review.machineId ?? 'named when it pairs'}
        </p>
      </div>
      {review.existing && review.machineId ? (
        <ReplaceMachineNotice
          machineId={review.machineId}
          busy={busy}
          onConfirm={onAuthorize}
          onCancel={onCancel}
        />
      ) : (
        <Button
          onClick={onAuthorize}
          disabled={busy}
          className="w-full cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          size={size}
        >
          {busy ? (
            <>
              <Loader2 className={`${icon} animate-spin`} />
              authorizing...
            </>
          ) : (
            <>
              <Monitor className={icon} />
              authorize machine
            </>
          )}
        </Button>
      )}
    </div>
  );
}
