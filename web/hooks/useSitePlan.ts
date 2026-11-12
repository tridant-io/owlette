'use client';

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import type { SitePlanResponse } from '@/lib/sitePlanResponse';

/**
 * a site's plan from `/api/sites/{siteId}/plan` (adr 0018), fetched once per
 * site per sign-in and shared by every caller: gates mount per page and per
 * machine card, and each one must not cost another tridant lookup.
 *
 * `plan` is undefined while loading or after a failure. nothing is gated or
 * locked then, nor while plans are not enforced, so a slow or failed lookup
 * never hides anything; the server gates every action regardless.
 */

/** what the site's plan does to its machines on the dashboard. all of it is cosmetic: the server decides. */
export interface SitePlan {
  /**
   * owlette free's machine limit when the machine falls outside it, so shows an
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

export interface SitePlanState extends SitePlan {
  plan: SitePlanResponse | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface Entry {
  uid: string;
  plan: SitePlanResponse | undefined;
  loading: boolean;
  error: string | null;
  // the request this entry waits on or took its answer from, so only the latest lands.
  request: number;
}

// whose plans the cache holds: signing out or switching account empties it.
let cacheUid: string | null = null;
const cache = new Map<string, Entry>();
let requests = 0;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getServerSnapshot = () => undefined;

function claim(uid: string | null): void {
  if (cacheUid === uid) return;
  cacheUid = uid;
  cache.clear();
  emit();
}

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

async function load(uid: string, siteId: string): Promise<void> {
  // a refresh still held by the account that signed out must not write into the next one's cache.
  if (uid !== cacheUid) return;
  const request = ++requests;
  // a refresh keeps the plan it has, so a gate doesn't flash while it reloads.
  cache.set(siteId, { uid, plan: cache.get(siteId)?.plan, loading: true, error: null, request });
  emit();
  let plan: SitePlanResponse | undefined;
  let error: string | null = null;
  try {
    const response = await fetch(`/api/sites/${encodeURIComponent(siteId)}/plan`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await readApiError(response, 'failed to load plan'));
    plan = (await response.json()) as SitePlanResponse;
  } catch (err) {
    error = err instanceof Error ? err.message : 'failed to load plan';
  }
  // gone after a sign-out, replaced by a newer request: either way this answer is stale.
  if (cache.get(siteId)?.request !== request) return;
  cache.set(siteId, { uid, plan, loading: false, error, request });
  emit();
}

const LIVE = () => null;
const UNRESTRICTED: SitePlan = { machineLimitFor: LIVE, controlLocked: false, swoopLocked: false };

/**
 * the locks every viewer of the site sees. owlette free is counted across the
 * owner's free sites, which only the server can read, so the site plan answer
 * names the machines it covers here (`freeMachines`); a machine paired since
 * that answer is outside them.
 */
export function sitePlan(site: SitePlanResponse | undefined): SitePlan {
  if (!site?.enforced) return UNRESTRICTED;
  const flags = { controlLocked: !site.flags.control, swoopLocked: !site.flags.swoop };
  const free = site.freeMachines;
  if (!free) return { ...flags, machineLimitFor: LIVE };
  const live = new Set(free.live);
  return { ...flags, machineLimitFor: (machineId) => (live.has(machineId) ? null : free.limit) };
}

/** a site on owlette free, whose machine locks change when a machine is paired or removed. */
const onFree = (site: SitePlanResponse | undefined) => !!site?.enforced && !site.inGoodStanding;

/**
 * `machineIdsKey` is the site's machine ids joined, or null while they load.
 * the site's plan is fetched once per sign-in, and pairing or removing a
 * machine changes which one owlette free keeps live, so a change to the set
 * on a free site asks for it again.
 */
export function useSitePlan(siteId: string | null | undefined, machineIdsKey: string | null = null): SitePlanState {
  const { user, loading: authLoading } = useAuth();
  // auth settles after the session cookie is minted; asking sooner would 401.
  const uid = !authLoading && user ? user.uid : null;
  const getSnapshot = useCallback(() => (siteId ? cache.get(siteId) : undefined), [siteId]);
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { loading: accountLoading, refresh: refreshAccount } = usePlan();

  useEffect(() => {
    claim(uid);
    // the account read starts the trial and registers the account's sites with tridant id. a site
    // read that beat it would keep the unregistered site's answer, owlette free, for the whole sign-in.
    if (uid && siteId && !accountLoading && !cache.has(siteId)) void load(uid, siteId);
  }, [uid, siteId, accountLoading]);

  const refresh = useCallback(async () => {
    if (uid && siteId) await load(uid, siteId);
  }, [uid, siteId]);

  // another account's entry, mid-switch, is not this user's view of the site.
  const mine = current?.uid === uid ? current : undefined;
  const plan = mine?.plan;
  const locks = useMemo(() => sitePlan(plan), [plan]);
  const counted = onFree(plan);
  const owner = !!plan?.isOwner;

  const seen = useRef<{ siteId: string; key: string } | null>(null);
  useEffect(() => {
    if (!siteId || machineIdsKey === null) return;
    const previous = seen.current;
    seen.current = { siteId, key: machineIdsKey };
    if (!counted || previous?.siteId !== siteId || previous.key === machineIdsKey) return;
    void refresh();
    // the owner's plan page counts the same machines.
    if (owner) void refreshAccount();
  }, [counted, owner, siteId, machineIdsKey, refresh, refreshAccount]);

  const loading = !!authLoading || (uid !== null && !!siteId && (!mine || mine.loading));
  const error = mine?.error ?? null;
  return useMemo(() => ({ ...locks, plan, loading, error, refresh }), [locks, plan, loading, error, refresh]);
}

export function __resetSitePlansForTests(): void {
  cacheUid = null;
  cache.clear();
  requests = 0;
}
