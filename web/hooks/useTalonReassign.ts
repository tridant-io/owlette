'use client';

import { useCallback } from 'react';

/**
 * Departure-time talon lookups + reassignment.
 *
 * Every talon re-checks its AUTHOR's site access before any output fires, so
 * removing the author from the site switches each of their talons off at its
 * next run, with nothing fired.
 * These calls let the removal flows say "this person wrote N talons" before the
 * removal, and hand them to somebody still here.
 *
 * API only, no Firestore listener: members can read
 * `sites/{siteId}/talons`, but the successor-eligibility check that makes a
 * reassignment safe exists server-side, and a client write path would skip it.
 */

/** One talon in the departure preview. */
export interface AuthoredTalon {
  id: string;
  name: string;
  enabled: boolean;
}

/** The same plus its site — the fleet-wide soft-delete shape. */
export interface AuthoredTalonAcrossSites {
  siteId: string;
  talonId: string;
  name: string;
  enabled: boolean;
}

export interface SiteAuthoredTalons {
  count: number;
  talons: AuthoredTalon[];
}

export interface UserAuthoredTalons {
  count: number;
  sites: { siteId: string; count: number }[];
  talons: AuthoredTalonAcrossSites[];
}

export interface UseTalonReassignReturn {
  /** Talons `uid` authored on one site. */
  fetchSiteAuthored: (siteId: string, uid: string) => Promise<SiteAuthoredTalons>;
  /** Talons `uid` authored anywhere — the account-deletion preview. */
  fetchUserAuthored: (uid: string) => Promise<UserAuthoredTalons>;
  /** Move every talon `fromUid` authored on `siteId` to `toUid`. */
  reassignSiteTalons: (
    siteId: string,
    fromUid: string,
    toUid: string,
  ) => Promise<{ reassignedTalonIds: string[] }>;
}

export function useTalonReassign(): UseTalonReassignReturn {
  const fetchSiteAuthored = useCallback(
    async (siteId: string, uid: string): Promise<SiteAuthoredTalons> => {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/talons/authored?uid=${encodeURIComponent(uid)}`,
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'failed to look up authored talons'));
      }
      const body = await response.json();
      return {
        count: typeof body.count === 'number' ? body.count : 0,
        talons: Array.isArray(body.talons) ? body.talons : [],
      };
    },
    [],
  );

  const fetchUserAuthored = useCallback(async (uid: string): Promise<UserAuthoredTalons> => {
    const response = await fetch(`/api/users/${encodeURIComponent(uid)}/talons`);
    if (!response.ok) {
      throw new Error(await readApiError(response, 'failed to look up authored talons'));
    }
    const body = await response.json();
    return {
      count: typeof body.count === 'number' ? body.count : 0,
      sites: Array.isArray(body.sites) ? body.sites : [],
      talons: Array.isArray(body.talons) ? body.talons : [],
    };
  }, []);

  const reassignSiteTalons = useCallback(
    async (siteId: string, fromUid: string, toUid: string) => {
      const response = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}/talons/reassign`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fromUid, toUid }),
        },
      );
      if (!response.ok) {
        throw new Error(await readApiError(response, 'failed to reassign talons'));
      }
      const body = await response.json();
      return {
        reassignedTalonIds: Array.isArray(body.reassignedTalonIds)
          ? body.reassignedTalonIds
          : [],
      };
    },
    [],
  );

  return { fetchSiteAuthored, fetchUserAuthored, reassignSiteTalons };
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.title ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}
