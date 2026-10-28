'use client';

/**
 * What every active-hours confirm shares: the warning box around what it names,
 * and the reason field with the footer that sends the override. The reason is
 * capped at what the server takes, and the override button stays off until
 * there is one.
 */

import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OVERRIDE_REASON_MAX } from '@/lib/activeHours';

export const ACTIVE_HOURS_NOTICE_CLASS = 'rounded-md border border-warning-border/60 bg-warning-surface';

interface OverrideReasonFieldProps {
  /** the override button, e.g. "restart now". */
  confirmLabel: string;
  sending: boolean;
  onCancel: () => void;
  onConfirm: (override: { reason: string }) => void;
  /** footer buttons after the override, such as a deferral. */
  children?: ReactNode;
}

export function OverrideReasonField({
  confirmLabel,
  sending,
  onCancel,
  onConfirm,
  children,
}: OverrideReasonFieldProps) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={reasonId}>reason</Label>
        <Input
          id={reasonId}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={OVERRIDE_REASON_MAX}
          placeholder="e.g. the venue is closed today"
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          cancel
        </Button>
        <Button
          variant="destructive"
          disabled={sending || !trimmed}
          onClick={() => onConfirm({ reason: trimmed })}
        >
          {confirmLabel}
        </Button>
        {children}
      </DialogFooter>
    </>
  );
}
