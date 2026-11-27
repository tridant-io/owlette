'use client';

import { useEffect, useState } from 'react';
import type { ListedMachineState } from '@/lib/machineStateLabel';

/** a machine as `GET /api/sites?include=machines` lists it under its site */
export interface ListedMachine extends ListedMachineState {
  id: string;
  name: string;
  agentVersion: string | null;
}

/** how often the list asks again while the page is open */
export const MACHINES_REFRESH_MS = 60_000;

export interface UseMachinesBySiteResult {
  /**
   * each listed site's machines, null for a site whose machines the caller
   * cannot reach. null until the first load lands; a failed refresh keeps the last good one.
   */
  machinesBySite: ReadonlyMap<string, readonly ListedMachine[] | null> | null;
  /** a request is in flight */
  loading: boolean;
  /** nothing has loaded, and the last try failed */
  failed: boolean;
}

/**
 * every site's machines in one request (`GET /api/sites?include=machines`, scope
 * checked server side), asked again every minute and whenever the site list
 * changes. a hidden tab skips its refreshes and catches up when it shows again,
 * since a superadmin's request reads every machine. nothing is asked for while
 * `siteIds` is empty.
 */
export function useMachinesBySite(siteIds: readonly string[]): UseMachinesBySiteResult {
  const [machinesBySite, setMachinesBySite] = useState<UseMachinesBySiteResult['machinesBySite']>(null);
  const [loading, setLoading] = useState(false);
  const [lastFailed, setLastFailed] = useState(false);
  // the ids as one value, so a fresh array of the same sites is not a new request
  const key = JSON.stringify([...siteIds].sort());

  useEffect(() => {
    if (key === '[]') return;
    let live = true;
    let askedAt = 0;
    const load = async () => {
      askedAt = Date.now();
      setLoading(true);
      try {
        const response = await fetch('/api/sites?include=machines');
        if (!response.ok) throw new Error(`failed to load machines (${response.status})`);
        const body = (await response.json()) as { sites: { id: string; machines: ListedMachine[] | null }[] };
        if (!live) return;
        setMachinesBySite(new Map(body.sites.map((s) => [s.id, s.machines])));
        setLastFailed(false);
      } catch (err: unknown) {
        if (!live) return;
        console.debug('[useMachinesBySite] machines did not load:', err);
        setLastFailed(true);
      } finally {
        if (live) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, MACHINES_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - askedAt >= MACHINES_REFRESH_MS) void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  return { machinesBySite, loading, failed: lastFailed && machinesBySite === null };
}
