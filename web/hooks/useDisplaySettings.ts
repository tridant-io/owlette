'use client';

/**
 * subscribe to a site's display policy (`sites/{siteId}/settings/display`).
 *
 * `keepAwake` reads true while loading, when the document or field is absent,
 * and when the read fails: on is the default, and it is what every agent does
 * until the document says otherwise. the parse duplicates `parseDisplaySettings`
 * because that module pulls in firebase-admin, which a client cannot import.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

export interface DisplaySettings {
  keepAwake: boolean;
}

const DEFAULTS: DisplaySettings = { keepAwake: true };

function parse(data: Record<string, unknown> | undefined): DisplaySettings {
  return { keepAwake: data?.keepAwake !== false };
}

export function useDisplaySettings(siteId: string): {
  settings: DisplaySettings;
  loading: boolean;
} {
  const [snapshot, setSnapshot] = useState<{ siteId: string; settings: DisplaySettings } | null>(
    null,
  );

  useEffect(() => {
    if (!siteId || !db) return;
    const unsub = onSnapshot(
      doc(db, 'sites', siteId, 'settings', 'display'),
      (snap) => setSnapshot({ siteId, settings: parse(snap.data()) }),
      (error) => {
        console.error('Failed to read display settings:', error);
        setSnapshot({ siteId, settings: DEFAULTS });
      },
    );
    return () => unsub();
  }, [siteId]);

  // keyed by site so a previous site's answer never stands in for this one's.
  const fresh = snapshot && snapshot.siteId === siteId ? snapshot.settings : null;
  return { settings: fresh ?? DEFAULTS, loading: Boolean(siteId && db) && fresh === null };
}
