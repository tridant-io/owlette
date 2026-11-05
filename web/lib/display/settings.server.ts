/**
 * the per-site display policy, `sites/{siteId}/settings/display`.
 *
 * service-account only in the rules; members read it straight from firestore
 * through `hooks/useDisplaySettings.ts`, and agents learn it from the
 * `/api/agent/site` projection. written by `lib/actions/setDisplaySettings.server.ts`.
 */

import { getAdminDb } from '@/lib/firebase-admin';

/** `sites/{siteId}/settings/display`. */
export const DISPLAY_SETTINGS_DOC = 'display';

export interface DisplaySiteSettings {
  keepAwake: boolean;
}

export function parseDisplaySettings(data: unknown): DisplaySiteSettings {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  // on unless the literal false: keeping screens awake is the default (owner,
  // 2026-10-03), so a site that never touched the switch has it on.
  return { keepAwake: raw.keepAwake !== false };
}

export async function loadDisplaySettings(siteId: string): Promise<DisplaySiteSettings> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('settings')
    .doc(DISPLAY_SETTINGS_DOC)
    .get();
  return parseDisplaySettings(snap.exists ? snap.data() : null);
}
