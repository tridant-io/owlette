'use client';

import { useCallback, useEffect, useState } from 'react';

/** a machine as `GET /api/sites/{siteId}/machines` lists it */
export interface SiteMachine {
  id: string;
  name: string;
  online: boolean;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  /** keep screens awake as the agent reports it; null before 4.1.1. only `held` is read here. */
  displayAwake?: { held?: boolean } | null;
  /** what tells whether the agent would refuse a restart inside active hours; null where it reports none. */
  osFamily?: string | null;
  capabilities?: { activeHoursGuard?: number } | null;
  activeHours?: unknown;
  machineTimezone?: string | null;
}

export interface UseSiteMachinesResult {
  /** null until the first load lands */
  machines: SiteMachine[] | null;
  error: string | null;
  /** never rejects: a failed load lands in `error` */
  refresh: () => Promise<void>;
}

/**
 * a site's machines through the api (admin-SDK, scope-checked server side)
 * rather than a client Firestore listener, so superadmins can inspect sites
 * they aren't members of without loosening rules.
 */
export function useSiteMachines(siteId: string): UseSiteMachinesResult {
  const [machines, setMachines] = useState<SiteMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/machines`);
      if (!response.ok) throw new Error(`failed to load machines (${response.status})`);
      const body = (await response.json()) as { machines: SiteMachine[] };
      setMachines(body.machines);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'failed to load machines');
    }
  }, [siteId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { machines, error, refresh };
}
