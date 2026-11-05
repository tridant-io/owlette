'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { PlanResponse } from '@/lib/plan.server';

/**
 * the signed-in user's plan from `/api/account/plan`, fetched once per sign-in
 * and shared by every caller: gates mount per page and per machine card, and
 * each one must not cost another tridant lookup.
 *
 * `plan` is undefined while loading or after a failure. gates render their
 * children then, so a slow or failed lookup never hides anything; the server
 * gates every action regardless.
 */

interface PlanState {
  uid: string | null;
  plan: PlanResponse | undefined;
  loading: boolean;
  error: string | null;
}

const SIGNED_OUT: PlanState = { uid: null, plan: undefined, loading: false, error: null };

let state = SIGNED_OUT;
// bumped per request and on sign-out, so only the latest answer lands.
let generation = 0;
const listeners = new Set<() => void>();

function setState(next: PlanState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => state;
const getServerSnapshot = () => SIGNED_OUT;

async function readApiError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? body.error ?? `${fallback} (${response.status})`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

async function load(uid: string): Promise<void> {
  const request = ++generation;
  // a refresh keeps the plan it has, so a gate doesn't flash while it reloads.
  setState({ uid, plan: state.uid === uid ? state.plan : undefined, loading: true, error: null });
  let next: PlanState;
  try {
    const response = await fetch('/api/account/plan', { cache: 'no-store' });
    if (!response.ok) throw new Error(await readApiError(response, 'failed to load plan'));
    next = { uid, plan: (await response.json()) as PlanResponse, loading: false, error: null };
  } catch (err) {
    next = { uid, plan: undefined, loading: false, error: err instanceof Error ? err.message : 'failed to load plan' };
  }
  if (request === generation) setState(next);
}

export function usePlan() {
  const { user, loading: authLoading } = useAuth();
  // auth settles after the session cookie is minted; asking sooner would 401.
  const uid = !authLoading && user ? user.uid : null;
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (uid === null) {
      if (state.uid !== null) {
        generation++;
        setState(SIGNED_OUT);
      }
    } else if (state.uid !== uid) {
      void load(uid);
    }
  }, [uid]);

  const refresh = useCallback(async () => {
    if (uid) await load(uid);
  }, [uid]);

  // another account's state, mid-switch, is not this user's plan.
  const mine = current.uid === uid ? current : null;
  return {
    plan: mine?.plan,
    loading: authLoading || (uid !== null && (!mine || mine.loading)),
    error: mine?.error ?? null,
    refresh,
  };
}

export function __resetPlanForTests(): void {
  state = SIGNED_OUT;
  generation = 0;
}
