'use client';

import { useEffect, useMemo, useRef } from 'react';
import { governingPlan } from '@/components/plan/UpgradeGate';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import type { PlanResponse } from '@/lib/plan.server';

/**
 * what the viewer's own plan does to one site's machines (plan.md decisions 9
 * and 14), on the sites `governingPlan` says it governs: anyone else's site
 * runs on its owner's plan, which this browser can't read, and the server
 * gates every action either way. all of it is cosmetic for the same reason.
 */
export interface SitePlan {
  /**
   * the plan's machine limit when the machine falls outside it, so shows an
   * upgrade notice instead of its metrics; null when it's live.
   */
  machineLimitFor: (machineId: string) => number | null;
  /**
   * the plan leaves out control: remote commands, process restart and kill,
   * display restore, and screenshots, live view included. configuration stays.
   */
  controlLocked: boolean;
  swoopLocked: boolean;
}

const LIVE = () => null;
const UNRESTRICTED: SitePlan = { machineLimitFor: LIVE, controlLocked: false, swoopLocked: false };

export function sitePlan(
  plan: PlanResponse | undefined,
  viewerUid: string | null | undefined,
  siteId: string,
  siteOwner: string | undefined,
): SitePlan {
  // an unknown owner is still a site, never an account feature.
  const governing = governingPlan(plan, viewerUid, siteOwner ?? null);
  if (!governing) return UNRESTRICTED;
  const flags = { controlLocked: !governing.flags.control, swoopLocked: !governing.flags.swoop };
  const limit = governing.limits.machines;
  const live = governing.liveMachines;
  // with a slot to spare, a machine missing from the list was paired after the plan loaded, and fits.
  if (limit === null || !live || live.length < limit) return { ...flags, machineLimitFor: LIVE };
  const liveHere = new Set(live.filter((m) => m.siteId === siteId).map((m) => m.machineId));
  return { ...flags, machineLimitFor: (machineId) => (liveHere.has(machineId) ? null : limit) };
}

/**
 * `machineIdsKey` is the site's machine ids joined, or null while they load.
 * the plan is fetched once per sign-in, and pairing or removing a machine
 * changes which one is live, so a change to the set asks again.
 */
export function useSitePlan(siteId: string, siteOwner: string | undefined, machineIdsKey: string | null = null): SitePlan {
  const { user } = useAuth();
  const { plan, refresh } = usePlan();
  const uid = user?.uid;
  const state = useMemo(() => sitePlan(plan, uid, siteId, siteOwner), [plan, uid, siteId, siteOwner]);
  const counted = state !== UNRESTRICTED && plan?.limits.machines != null;

  const seen = useRef<{ siteId: string; key: string } | null>(null);
  useEffect(() => {
    if (machineIdsKey === null) return;
    const previous = seen.current;
    seen.current = { siteId, key: machineIdsKey };
    if (counted && previous?.siteId === siteId && previous.key !== machineIdsKey) void refresh();
  }, [counted, siteId, machineIdsKey, refresh]);

  return state;
}
