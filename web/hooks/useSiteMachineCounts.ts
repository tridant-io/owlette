'use client';

import { useEffect, useState } from 'react';
import { collection, documentId, getCountFromServer, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { MAX_MACHINE_SCOPE } from '@/lib/machineAccess';

type Scope = readonly string[] | null;

/**
 * how many machines each site holds, counted on the server each time `open`
 * turns true: the header is on every page, so nothing is read until its site
 * list shows. a scoped member counts the machines they reach, which is what
 * their dashboard lists; the rules refuse them a count of the rest. a site whose
 * count fails has no entry.
 */
export function useSiteMachineCounts(
  siteIds: readonly string[],
  machineScope: (siteId: string) => Scope,
  open: boolean,
): Readonly<Record<string, number>> {
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  // the sites and their scopes as one value, so a fresh array or callback is not a new read
  const key = JSON.stringify(siteIds.map((siteId) => [siteId, machineScope(siteId)]));

  useEffect(() => {
    if (!open || !db) return;
    const firestore = db;
    const sites = JSON.parse(key) as [string, Scope][];
    let live = true;
    void Promise.allSettled(
      sites.map(async ([siteId, scope]) => {
        if (scope?.length === 0) return [siteId, 0] as const;
        const machines = collection(firestore, 'sites', siteId, 'machines');
        // the dashboard lists only the first MAX_MACHINE_SCOPE, so the count stops there too
        const counted = scope === null ? machines : query(machines, where(documentId(), 'in', scope.slice(0, MAX_MACHINE_SCOPE)));
        const snapshot = await getCountFromServer(counted);
        return [siteId, snapshot.data().count] as const;
      }),
    ).then((results) => {
      if (!live) return;
      const next: Record<string, number> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
        else console.debug('[useSiteMachineCounts] a site count failed:', result.reason);
      }
      setCounts(next);
    });
    return () => {
      live = false;
    };
  }, [open, key]);

  return counts;
}
