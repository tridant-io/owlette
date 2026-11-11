'use client';

import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { useSwoopSettings } from '@/hooks/useSwoopSettings';
import { useDisplaySettings } from '@/hooks/useDisplaySettings';

interface SiteSettingSwitchProps {
  id: string;
  label: string;
  description: string;
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
function SiteSettingSwitch({ id, label, description, checked, loading, url, field }: SiteSettingSwitchProps) {
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
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="text-foreground">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(next) => void save(next)}
        disabled={busy || loading}
      />
    </div>
  );
}

const siteApi = (siteId: string) => `/api/sites/${encodeURIComponent(siteId)}`;

/** the site's swoop switch, on admin panel → swoop → settings. */
export function SwoopSwitch({ siteId }: { siteId: string }) {
  const swoop = useSwoopSettings(siteId);

  return (
    <SiteSettingSwitch
      id={`swoop-${siteId}`}
      label="swoop"
      description={
        swoop.settings.membersMayWatch
          ? "by default, owners and admins watch and control this site's machines remotely, and members watch. change it per person in members."
          : "by default, owners and admins watch and control this site's machines remotely; members don't watch. change it per person in members."
      }
      checked={swoop.settings.enabled}
      loading={swoop.loading}
      url={`${siteApi(siteId)}/swoop-settings`}
      field="enabled"
    />
  );
}

/** the site's keep screens awake switch, on its settings page's machines section. */
export function KeepScreensAwakeSwitch({ siteId }: { siteId: string }) {
  const display = useDisplaySettings(siteId);

  return (
    <SiteSettingSwitch
      id={`keep-awake-${siteId}`}
      label="keep screens awake"
      description="machines on this site never sleep, blank or lock"
      checked={display.settings.keepAwake}
      loading={display.loading}
      url={`${siteApi(siteId)}/display-settings`}
      field="keepAwake"
    />
  );
}
