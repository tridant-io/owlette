'use client';

import { useCallback } from 'react';
import type { StoredFleetGrant } from '@/lib/fleet/grant';

export interface FleetSettingsPatch {
  enabled?: boolean;
  /** the whole new map: a sender left out is removed */
  senders?: Record<string, StoredFleetGrant>;
}

/**
 * the one writer of a site's fleet settings: PATCH through the route, which
 * holds the capability and second-factor checks. throws the server's detail on
 * a refusal, for the caller to show.
 */
export function useFleetSettingsWrite(siteId: string): (patch: FleetSettingsPatch) => Promise<void> {
  return useCallback(
    async (patch) => {
      const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/fleet-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.title || 'try again in a moment.');
      }
    },
    [siteId],
  );
}
