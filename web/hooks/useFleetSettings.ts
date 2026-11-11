'use client';

/**
 * subscribe to a site's fleet grant (`sites/{siteId}/settings/fleet`): which
 * machines may act on the site's machines, at what tier and on which machines.
 *
 * read through `parseFleetSettings`, the parser the server enforces, so the ui
 * never shows a grant the server would not honour. defaults to off with no
 * senders whenever the document or the read is missing.
 */

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { parseFleetSettings, type FleetSettings } from '@/lib/fleet/grant';

const DEFAULTS: FleetSettings = parseFleetSettings(null);

export function useFleetSettings(siteId: string): {
  settings: FleetSettings;
  loading: boolean;
} {
  const [snapshot, setSnapshot] = useState<{ siteId: string; settings: FleetSettings } | null>(
    null,
  );

  useEffect(() => {
    if (!siteId || !db) return;
    const unsub = onSnapshot(
      doc(db, 'sites', siteId, 'settings', 'fleet'),
      (snap) => setSnapshot({ siteId, settings: parseFleetSettings(snap.data() ?? null) }),
      (error) => {
        console.error('Failed to read fleet settings:', error);
        setSnapshot({ siteId, settings: DEFAULTS });
      },
    );
    return () => unsub();
  }, [siteId]);

  // a snapshot of the previous site is not this site's answer, so the default
  // stands until the new subscription reports.
  const fresh = snapshot && snapshot.siteId === siteId ? snapshot.settings : null;
  // nothing is coming without a site or a db, so those are not "loading".
  return { settings: fresh ?? DEFAULTS, loading: Boolean(siteId && db) && fresh === null };
}
