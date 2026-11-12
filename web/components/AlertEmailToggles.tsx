'use client';

import { useEffect, useState } from 'react';
import { useAuth, type UserPreferences } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

type AlertKey =
  | 'healthAlerts'
  | 'processAlerts'
  | 'thresholdAlerts'
  | 'cortexAlerts'
  | 'displayAlerts'
  | 'talonAlerts'
  | 'apiKeyAlerts';

const ALERT_TOGGLES: { key: AlertKey; label: string; desc: string }[] = [
  {
    key: 'healthAlerts',
    label: 'machine offline alerts',
    desc: 'receive email alerts when machines go offline',
  },
  {
    key: 'processAlerts',
    label: 'process crash alerts',
    desc: 'receive email alerts when monitored processes crash or fail to start',
  },
  {
    key: 'thresholdAlerts',
    label: 'threshold alerts',
    desc: 'receive email alerts when health metrics (CPU, GPU temp, disk, etc.) exceed configured thresholds',
  },
  {
    key: 'cortexAlerts',
    label: 'hoot escalation alerts',
    desc: "receive email alerts when automated diagnostics can't resolve an issue",
  },
  {
    key: 'displayAlerts',
    label: 'display events',
    desc: 'receive email alerts when monitors are removed, layouts drift, or display apply fails',
  },
  {
    key: 'talonAlerts',
    label: 'talon alerts',
    desc: 'emails when a talon fires or fails',
  },
  {
    key: 'apiKeyAlerts',
    label: 'api key expiry',
    desc: 'emails before an api key expires',
  },
];

function pickAlertPrefs(p: UserPreferences): Record<AlertKey, boolean> {
  return {
    healthAlerts: p.healthAlerts,
    processAlerts: p.processAlerts,
    thresholdAlerts: p.thresholdAlerts,
    cortexAlerts: p.cortexAlerts,
    displayAlerts: p.displayAlerts,
    talonAlerts: p.talonAlerts,
    apiKeyAlerts: p.apiKeyAlerts,
  };
}

/**
 * the signed-in person's built-in alert emails, one switch each, on /settings/alerts
 * and admin panel → alerts. each saves as it moves (optimistic, reverting on failure).
 */
export function AlertEmailToggles() {
  const { userPreferences, updateUserPreferences } = useAuth();
  const [prefs, setPrefs] = useState<Record<AlertKey, boolean>>(() => pickAlertPrefs(userPreferences));
  const [savingKey, setSavingKey] = useState<AlertKey | null>(null);

  // `userPreferences` only changes reference when preferences actually change
  useEffect(() => {
    setPrefs(pickAlertPrefs(userPreferences));
  }, [userPreferences]);

  const toggle = async (key: AlertKey, value: boolean) => {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);
    try {
      await updateUserPreferences({ [key]: value } as Partial<UserPreferences>, { silent: true });
    } catch {
      // updateUserPreferences already surfaces a toast; revert the switch
      setPrefs((prev) => ({ ...prev, [key]: !value }));
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="space-y-3">
      {ALERT_TOGGLES.map(({ key, label, desc }) => (
        <div key={key} className="flex items-center gap-2 p-3 sm:gap-4 sm:p-4 rounded-lg border border-border bg-card">
          <Switch
            id={key}
            checked={prefs[key]}
            onCheckedChange={(v) => void toggle(key, v)}
            disabled={savingKey !== null}
          />
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={key} className="text-foreground">
              {label}
            </Label>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
