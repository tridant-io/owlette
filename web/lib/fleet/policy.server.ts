/**
 * loads a site's fleet grant, the `sites/{siteId}/settings/fleet` document
 * (ADR 0017). the reading itself lives in `lib/fleet/grant.ts`, which the
 * dashboard imports too; it is re-exported here so server callers keep one
 * import.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { parseFleetSettings, type FleetSettings } from '@/lib/fleet/grant';

export {
  MAX_FLEET_SENDERS,
  fleetGrantFor,
  grantCovers,
  parseFleetSettings,
  storedFleetGrant,
} from '@/lib/fleet/grant';
export type { FleetGrant, FleetSettings, StoredFleetGrant } from '@/lib/fleet/grant';

/** `sites/{siteId}/settings/fleet`. */
export const FLEET_SETTINGS_DOC = 'fleet';

export async function loadFleetSettings(
  siteId: string,
  opts: { db?: Firestore } = {},
): Promise<FleetSettings> {
  const snap = await (opts.db ?? getAdminDb())
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc(FLEET_SETTINGS_DOC)
    .get();
  return parseFleetSettings(snap.exists ? snap.data() : null);
}
