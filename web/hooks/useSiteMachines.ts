'use client';

import { useCallback, useEffect, useState } from 'react';

/** a machine as `GET /api/sites/{siteId}/machines` lists it */
export interface SiteMachine {
  id: string;
  name: string;
  /** the agent's flag and a fresh heartbeat, as the dashboard reads it */
  online: boolean;
  /** the agent marked it asleep; `online` is false meanwhile */
  asleep: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  /** keep screens awake as the agent reports it; null before 4.1.1. only `held` is read here. */
  displayAwake?: { held?: boolean } | null;
  /** what tells whether the agent would refuse a restart inside active hours; null where it reports none. */
  osFamily?: string | null;
  capabilities: { activeHoursGuard?: number; siteMove?: number } | null;
  activeHours?: unknown;
  machineTimezone?: string | null;
  /** the move out of this site, while it is pending or switching; `expiresAt` is epoch ms. */
  pendingMove: {
    targetSiteId: string;
    targetSiteName: string;
    status: 'pending' | 'switching';
    expiresAt: number;
  } | null;
}

export interface UseSiteMachinesResult {
  /** null until the first load lands */
  machines: SiteMachine[] | null;
  error: string | null;
  /**
   * never rejects: a failed load lands in `error`. a background refresh repaints in place:
   * it leaves `error` and the last good list alone, so a poll that fails unmounts nothing
   */
  refresh: (options?: { background?: boolean }) => Promise<void>;
}

/**
 * a site's machines through the api (admin-SDK, scope-checked server side)
 * rather than a client Firestore listener, so superadmins can inspect sites
 * they aren't members of without loosening rules.
 */
export function useSiteMachines(siteId: string): UseSiteMachinesResult {
  const [machines, setMachines] = useState<SiteMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background === true;
    if (!background) setError(null);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/machines`);
      if (!response.ok) throw new Error(`failed to load machines (${response.status})`);
      const body = (await response.json()) as { machines: SiteMachine[] };
      setMachines(body.machines);
    } catch (err: unknown) {
      if (!background) setError(err instanceof Error ? err.message : 'failed to load machines');
    }
  }, [siteId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { machines, error, refresh };
}
