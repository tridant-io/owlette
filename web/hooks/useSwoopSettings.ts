'use client';

/**
 * Subscribe to a site's swoop policy (`sites/{siteId}/settings/swoop`).
 *
 * Defaults to the SAFE state — off — whenever the document, the field or the
 * read itself is missing, so the ui never shows swoop as available on a site
 * that has not turned it on. The server decides regardless
 * (`lib/swoop/policy.server.ts`); this only keeps the ui from lying.
 *
 * The parse is a small duplicate of `parseSwoopSettings` on purpose: that
 * module pulls in firebase-admin and cannot be imported from a client
 * component. It keeps the same rule — only the literal booleans move a field
 * off its default.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export type SwoopIndicator = 'banner' | 'tray' | 'none';

export interface SwoopSettings {
  enabled: boolean;
  excludedMachineIds: string[];
  membersMayWatch: boolean;
  indicator: SwoopIndicator;
}

const DEFAULTS: SwoopSettings = {
  enabled: false,
  excludedMachineIds: [],
  membersMayWatch: true,
  indicator: 'banner',
};

function parse(data: Record<string, unknown> | undefined): SwoopSettings {
  if (!data) return DEFAULTS;
  const indicator = data.indicator;
  return {
    enabled: data.enabled === true,
    excludedMachineIds: Array.isArray(data.excludedMachineIds)
      ? data.excludedMachineIds.filter((v): v is string => typeof v === 'string')
      : [],
    membersMayWatch: data.membersMayWatch !== false,
    indicator:
      indicator === 'banner' || indicator === 'tray' || indicator === 'none'
        ? indicator
        : DEFAULTS.indicator,
  };
}

export function useSwoopSettings(siteId: string): {
  settings: SwoopSettings;
  loading: boolean;
} {
  const [snapshot, setSnapshot] = useState<{ siteId: string; settings: SwoopSettings } | null>(
    null,
  );

  useEffect(() => {
    if (!siteId || !db) return;
    const unsub = onSnapshot(
      doc(db, 'sites', siteId, 'settings', 'swoop'),
      (snap) => setSnapshot({ siteId, settings: parse(snap.data()) }),
      (error) => {
        console.error('Failed to read swoop settings:', error);
        setSnapshot({ siteId, settings: DEFAULTS });
      },
    );
    return () => unsub();
  }, [siteId]);

  // A snapshot of the PREVIOUS site is not this site's answer, so the safe
  // default stands until the new subscription reports. Keying the state by site
  // rather than resetting it in the effect also keeps the reset out of render.
  const fresh = snapshot && snapshot.siteId === siteId ? snapshot.settings : null;
  // Nothing is coming without a site or a db, so those are not "loading".
  return { settings: fresh ?? DEFAULTS, loading: Boolean(siteId && db) && fresh === null };
}
