'use client';

/**
 * Live display events for one machine, from `sites/{siteId}/logs` (the agent
 * stamps each doc with `machineId` — see `log_event` in firebase_client.py).
 * Newest first.
 */

import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';

export interface DisplayEventEntry {
  id: string;
  action: string;
  level: string;
  details: string;
  machineId: string;
  machineName: string;
  timestamp: number;
}

export interface UseDisplayEventFeedResult {
  events: DisplayEventEntry[];
  loading: boolean;
  error: string | null;
}

export interface UseDisplayEventFeedOptions {
  enabled?: boolean;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const EMPTY_EVENTS: DisplayEventEntry[] = [];

/**
 * Every `display_*` action the agent emits (owlette_service `_emit_display_event`
 * and the display_manager audit/apply paths). SINGLE SOURCE OF TRUTH on the web
 * side — the feed filters on this set server-side.
 *
 * Add new agent actions HERE or they silently never appear. Firestore caps an
 * `in` filter at 30 values; currently 16.
 */
export const DISPLAY_EVENT_ACTIONS = [
  'display_monitor_added',
  'display_monitor_removed',
  'display_monitor_swapped',
  'display_drift',
  'display_mosaic_disabled',
  'display_sync_lost',
  'display_apply_succeeded',
  'display_apply_failed',
  'display_apply_refused_mosaic',
  'display_apply_acked',
  'display_auto_revert_fired',
  'display_revert_deferred',
  'display_auto_restore_fired',
  'display_auto_restore_skipped_unfixable',
  'display_auto_restore_circuit_breaker_tripped',
  'display_auto_restore_parked',
] as const;

/**
 * Firestore timestamp -> epoch ms. Mirrors the `useDisplayState` helper: Timestamp
 * instance, plain `{seconds, nanoseconds}` (SSR / fixtures), raw number, else 0.
 */
function normalizeTimestamp(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const asObj = value as { toMillis?: () => number; seconds?: unknown };
    if (typeof asObj.toMillis === 'function') {
      try {
        return asObj.toMillis();
      } catch {
        return 0;
      }
    }
    if (typeof asObj.seconds === 'number') {
      return asObj.seconds * 1000;
    }
  }
  return 0;
}

interface InternalState {
  siteId: string;
  machineId: string;
  events: DisplayEventEntry[];
  loaded: boolean;
  error: string | null;
}

export function useDisplayEventFeed(
  siteId: string,
  machineId: string,
  options?: UseDisplayEventFeedOptions,
): UseDisplayEventFeedResult {
  const enabled = options?.enabled ?? true;
  const requestedLimit = options?.limit ?? DEFAULT_LIMIT;
  const demo = useDemoContext();

  // Tagged with its (siteId, machineId) so async snapshot callbacks can discard
  // results for a prior target without a synchronous setState on target change.
  const [state, setState] = useState<InternalState>(() => ({
    siteId: '',
    machineId: '',
    events: EMPTY_EVENTS,
    loaded: false,
    error: null,
  }));

  useEffect(() => {
    if (!db || !siteId || !machineId || !enabled || demo) {
      // Demo / disabled / missing target are handled in the render path; the
      // prior run's cleanup already tore down any live subscription.
      return;
    }

    // Filter by action SERVER-SIDE, or a burst of unrelated logs (crashes,
    // commands, deploys) pushes display events out of the limit window.
    // The orderBy is essential: without it Firestore orders by document id, and
    // log ids are random UUIDs, so the limit would slice a time-agnostic subset.
    // Backed by the (action, machineId, timestamp DESC) composite index.
    const logsRef = collection(db, 'sites', siteId, 'logs');
    const q = query(
      logsRef,
      where('machineId', '==', machineId),
      where('action', 'in', [...DISPLAY_EVENT_ACTIONS]),
      orderBy('timestamp', 'desc'),
      limit(requestedLimit),
    );

    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        const next: DisplayEventEntry[] = [];
        const candidates = snap.docs
          .map((docSnap) => {
            const data = docSnap.data() as Record<string, unknown>;
            return { docSnap, data, timestamp: normalizeTimestamp(data.timestamp) };
          })
          .sort((a, b) => b.timestamp - a.timestamp);

        // The query already restricts + caps, so every doc is a display event.
        for (const { docSnap, data, timestamp } of candidates) {
          const action = typeof data.action === 'string' ? data.action : '';
          next.push({
            id: docSnap.id,
            action,
            level: typeof data.level === 'string' ? data.level : 'info',
            details: typeof data.details === 'string' ? data.details : '',
            machineId: typeof data.machineId === 'string' ? data.machineId : machineId,
            machineName: typeof data.machineName === 'string' ? data.machineName : '',
            timestamp,
          });
        }
        setState({
          siteId,
          machineId,
          events: next,
          loaded: true,
          error: null,
        });
      },
      (err) => {
        console.error('Error subscribing to display event feed:', err);
        setState({
          siteId,
          machineId,
          events: EMPTY_EVENTS,
          loaded: true,
          error: 'events unavailable',
        });
      },
    );

    return () => {
      unsubscribe();
    };
  }, [siteId, machineId, enabled, requestedLimit, demo]);

  // Demo route: no synthesized display events yet, and the demo site/machine docs
  // don't exist — hitting Firestore would surface a permission error.
  if (demo) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  if (!db) {
    return { events: EMPTY_EVENTS, loading: false, error: 'Firebase not configured' };
  }

  if (!enabled) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  if (!siteId || !machineId) {
    return { events: EMPTY_EVENTS, loading: false, error: null };
  }

  // New target, first snapshot still pending — report loading/empty so callers
  // never see the previous machine's values.
  if (state.siteId !== siteId || state.machineId !== machineId) {
    return { events: EMPTY_EVENTS, loading: true, error: null };
  }

  return {
    events: state.events,
    loading: !state.loaded,
    error: state.error,
  };
}
