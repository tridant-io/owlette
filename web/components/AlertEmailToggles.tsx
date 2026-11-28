'use client';

import { useId, useState } from 'react';
import { useAuth, type UserPreferences } from '@/contexts/AuthContext';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AlertDelivery } from '@/lib/alerts/delivery';
import { isValidTimezone } from '@/lib/timeUtils';

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

const DELIVERY_OPTIONS: { value: AlertDelivery; label: string }[] = [
  { value: 'immediate', label: 'as it happens' },
  { value: 'hourly', label: 'hourly digest' },
  { value: 'daily', label: 'daily digest' },
  { value: 'weekly', label: 'weekly digest' },
];

const DELIVERY_HELP: Record<AlertDelivery, string> = {
  immediate: 'one email for each alert, the moment it happens.',
  hourly: 'one email an hour with everything that happened. nothing is sent when nothing happened.',
  daily: 'one email at 8:00 am your time with everything that happened. nothing is sent when nothing happened.',
  weekly: 'one email on mondays at 8:00 am your time with everything that happened. nothing is sent when nothing happened.',
};

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
 * the signed-in person's built-in alert emails: how they arrive (each as it
 * happens, or one digest an hour, a day or a week) and one switch per category,
 * on /settings/alerts, admin panel → alerts and the account-settings dialog.
 * each saves as it moves (optimistic, reverting on failure). `onChangeTimezone`
 * makes the named timezone a link, where the page holds the timezone picker.
 */
export function AlertEmailToggles({ onChangeTimezone }: { onChangeTimezone?: () => void } = {}) {
  const { userPreferences, storedTimezone, updateUserPreferences } = useAuth();
  // the dialog can open over admin → alerts, which renders this too: ids must not collide
  const idPrefix = useId();
  const [prefs, setPrefs] = useState<Record<AlertKey, boolean>>(() => pickAlertPrefs(userPreferences));
  const [delivery, setDelivery] = useState<AlertDelivery>(userPreferences.alertDelivery);
  const [savingKey, setSavingKey] = useState<AlertKey | 'alertDelivery' | null>(null);

  // follow the stored preferences by value, not by object: a caller that hands a
  // fresh object each render would otherwise re-sync forever
  const stored = [...ALERT_TOGGLES.map(({ key }) => String(userPreferences[key])), userPreferences.alertDelivery].join();
  const [synced, setSynced] = useState(stored);
  if (synced !== stored) {
    setSynced(stored);
    setPrefs(pickAlertPrefs(userPreferences));
    setDelivery(userPreferences.alertDelivery);
  }

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

  const changeDelivery = async (value: AlertDelivery) => {
    const previous = delivery;
    setDelivery(value);
    setSavingKey('alertDelivery');
    try {
      await updateUserPreferences({ alertDelivery: value }, { silent: true });
    } catch {
      setDelivery(previous);
    } finally {
      setSavingKey(null);
    }
  };

  const deliveryId = `${idPrefix}-alertDelivery`;
  const zoned = delivery === 'daily' || delivery === 'weekly';
  // the zone the digest is sent in: the stored one, else UTC, as the server reads it (never the browser's)
  const digestZone = storedTimezone && isValidTimezone(storedTimezone) ? storedTimezone : null;

  return (
    <div className="space-y-3">
      <div className="space-y-2 p-3 sm:p-4 rounded-lg border border-border bg-card">
        <Label htmlFor={deliveryId} className="text-foreground">
          alert emails arrive
        </Label>
        <Select value={delivery} onValueChange={(v: AlertDelivery) => void changeDelivery(v)} disabled={savingKey !== null}>
          <SelectTrigger id={deliveryId} className="border-border bg-background text-foreground hover:bg-secondary w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-border dark:bg-secondary text-foreground">
            {DELIVERY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} className="cursor-pointer">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {DELIVERY_HELP[delivery]}
          {zoned && (
            <>
              {' '}your time is <span className="font-medium text-foreground">{digestZone ?? 'UTC'}</span>
              {digestZone ? '' : ' until you set your timezone'}
              {onChangeTimezone ? (
                <>
                  {' · '}
                  <button type="button" onClick={onChangeTimezone} className="hl-link cursor-pointer text-accent-cyan">
                    {digestZone ? 'change' : 'set your timezone'}
                  </button>
                </>
              ) : (
                `, ${digestZone ? 'set' : 'set it'} in account settings → preferences.`
              )}
            </>
          )}
          {' '}talon and api key emails always arrive as they happen.
        </p>
      </div>
      {ALERT_TOGGLES.map(({ key, label, desc }) => (
        <div key={key} className="flex items-center gap-2 p-3 sm:gap-4 sm:p-4 rounded-lg border border-border bg-card">
          <Switch
            id={`${idPrefix}-${key}`}
            checked={prefs[key]}
            onCheckedChange={(v) => void toggle(key, v)}
            disabled={savingKey !== null}
          />
          <div className="min-w-0 space-y-0.5">
            <Label htmlFor={`${idPrefix}-${key}`} className="text-foreground">
              {label}
            </Label>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
