'use client';

/**
 * Site-scoped page state: the visible site list plus the current selection.
 *
 * This was hand-rolled five times (dashboard, deployments, logs, roosts,
 * talons) and the copies disagreed — three treated "no site selected" as
 * indistinguishable from "still loading", which left brand-new accounts on a
 * permanent spinner at /deployments, /logs and /roosts instead of being told
 * they had no sites.
 *
 * `hasNoSites` makes that distinction explicit; prefer it over `!currentSiteId`,
 * which is also true mid-load.
 */

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useSites, type Site } from '@/hooks/useFirestore';

export interface UseCurrentSiteResult {
  /** Sites the caller can see. Empty until the listener delivers. */
  sites: Site[];
  /** Selected site id, or `''` when nothing is selectable yet. */
  currentSiteId: string;
  /** The selected site document, when one is resolved. */
  currentSite: Site | undefined;
  /** IANA timezone of the selected site, for timestamp rendering. */
  siteTimezone: string | undefined;
  /**
   * Whether the selected site evaluates process schedules in site time.
   * Three-state: `undefined` = never asked (schedules stay machine-local),
   * `false` = declined, `true` = site time. `undefined` is meaningful — do not
   * coalesce it to `false`.
   */
  schedulesFollowSiteTime: boolean | undefined;
  /** True while the site list is still resolving. */
  sitesLoading: boolean;
  /**
   * True once loading has settled and the caller has no sites at all.
   * Distinct from `!currentSiteId`, which is also true mid-load.
   */
  hasNoSites: boolean;
  /** Select a site and persist it as the caller's last site. */
  selectSite: (siteId: string) => void;
  sitesError: string | null;
}

export function useCurrentSite(): UseCurrentSiteResult {
  const { user, userSites, isSuperadmin, lastSiteId, updateLastSite } = useAuth();
  const {
    sites,
    loading: sitesLoading,
    error: sitesError,
  } = useSites(user?.uid, userSites, isSuperadmin);

  // '' means "no explicit pick yet": fall back to lastSiteId, then
  // localStorage, then the first accessible site.
  const [userPickedSiteId, setUserPickedSiteId] = useState<string>('');

  // Derived during render, not synced through an effect, so a changing site
  // list can't cascade re-renders (`react-hooks/set-state-in-effect`).
  const currentSiteId = useMemo(() => {
    if (userPickedSiteId && sites.some((s) => s.id === userPickedSiteId)) {
      return userPickedSiteId;
    }
    if (sitesLoading || sites.length === 0) return '';
    const savedSite =
      lastSiteId ||
      (typeof window !== 'undefined'
        ? localStorage.getItem('owlette_current_site')
        : null);
    if (savedSite && sites.some((s) => s.id === savedSite)) return savedSite;
    return sites[0].id;
  }, [userPickedSiteId, sites, sitesLoading, lastSiteId]);

  const currentSite = useMemo(
    () => sites.find((s) => s.id === currentSiteId),
    [sites, currentSiteId],
  );

  const selectSite = useCallback(
    (siteId: string) => {
      setUserPickedSiteId(siteId);
      updateLastSite(siteId);
    },
    [updateLastSite],
  );

  return {
    sites,
    currentSiteId,
    currentSite,
    siteTimezone: currentSite?.timezone,
    schedulesFollowSiteTime: currentSite?.schedulesFollowSiteTime,
    sitesLoading,
    hasNoSites: !sitesLoading && sites.length === 0,
    selectSite,
    sitesError,
  };
}
