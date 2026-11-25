'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';

interface ImmediateSwitchProps {
  id: string;
  /** the switch's accessible name, and what a failure toast says could not change. */
  label: string;
  checked: boolean;
  loading: boolean;
  /** PATCHed with `{ [field]: next }` the moment the switch moves. */
  url: string;
  field: string;
}

/**
 * one immediate site setting, outside any save: the PATCH nudges the site's
 * online machines, which a cancel could not take back. the switch follows its
 * snapshot hook, so only a failure needs saying.
 */
export function ImmediateSwitch({ id, label, checked, loading, url, field }: ImmediateSwitchProps) {
  const [busy, setBusy] = useState(false);

  const save = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'try again in a moment.');
      }
    } catch (err) {
      console.error(`Failed to update ${label}:`, err);
      toast.error(`could not change ${label}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Switch
      id={id}
      aria-label={label}
      checked={checked}
      onCheckedChange={(next) => void save(next)}
      disabled={busy || loading}
    />
  );
}

/** an immediate switch with its label and a line under it. */
export function SettingSwitch({ id, label, description, ...rest }: ImmediateSwitchProps & { description: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-foreground">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ImmediateSwitch id={id} label={label} {...rest} />
    </div>
  );
}
