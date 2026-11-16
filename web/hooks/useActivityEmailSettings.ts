'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The activity email switch and address list for the superadmin card on admin →
 * alerts, through `/api/admin/activity/settings` on the signed-in session. A save
 * shows at once and rolls back to the last saved state when it fails.
 */

export interface ActivityEmailSettings {
  enabled: boolean;
  recipients: string[];
  /** where mail goes while `recipients` is empty; null when nothing is configured */
  fallback: string | null;
}

const SETTINGS_URL = '/api/admin/activity/settings';

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useActivityEmailSettings() {
  const [settings, setSettings] = useState<ActivityEmailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(SETTINGS_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(await readApiError(response, 'failed to load activity email settings'));
        const body = (await response.json()) as ActivityEmailSettings;
        if (live) setSettings(body);
      } catch (err) {
        console.error('Error fetching activity email settings:', err);
        if (live) setError(errorMessage(err, 'failed to load activity email settings'));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /** resolves with the problem when the save failed, null when it landed */
  const save = useCallback(
    async (next: Pick<ActivityEmailSettings, 'enabled' | 'recipients'>): Promise<string | null> => {
      if (busy.current) return null;
      busy.current = true;
      setSaving(true);
      const saved = settings;
      setSettings((prev) => (prev ? { ...prev, ...next } : prev));
      try {
        const response = await fetch(SETTINGS_URL, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        if (!response.ok) throw new Error(await readApiError(response, 'failed to save activity email settings'));
        setSettings((await response.json()) as ActivityEmailSettings);
        setError(null);
        return null;
      } catch (err) {
        console.error('Error saving activity email settings:', err);
        setSettings(saved);
        const message = errorMessage(err, 'failed to save activity email settings');
        setError(message);
        return message;
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [settings],
  );

  return { settings, loading, saving, error, save };
}
