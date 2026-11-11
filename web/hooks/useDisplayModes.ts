'use client';

/**
 * Per-monitor catalogue of supported display modes. Subscribes to
 * `sites/{siteId}/machines/{machineId}/hardware/displayModes` and exposes it.
 * Feeds the resolution + refresh dropdowns in the display editor.
 *
 * With `triggerForHash` (the live profile's `signatureHash`) and `enabled`, it
 * fires `enumerateDisplayModes` once per (site, machine, hash) per tab
 * lifetime: a stale or missing cache re-enumerates, a fresh one is a pure read.
 */

import { useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDisplayActions } from '@/hooks/useDisplayActions';

export interface DisplayModeEntry {
  w: number;
  h: number;
  /** Hertz. */
  hz: number;
}

export interface DisplayModesEntry {
  /** `{w, h, hz}` triples, pre-filtered and sorted descending by the agent
   * (`_enum_modes_for_monitor`). */
  modes: DisplayModeEntry[];
  /** Integer DPI scale percents, from the agent's static `_DPI_SCALE_TABLE`
   * (not yet per-monitor). */
  dpiScales: number[];
}

export interface DisplayModesCatalogue {
  /** Catalogue schema version (currently 1). */
  schemaVersion: number;
  /** Topology hash when the catalogue was built; compared against the live
   * profile's hash to detect staleness. */
  signatureHash: string;
  /** Unix seconds, captured on the agent. */
  capturedAt: number;
  /** Per-monitor modes keyed by the monitor's edidHash. */
  byEdidHash: Record<string, DisplayModesEntry>;
}

export interface UseDisplayModesResult {
  /** Current catalogue, or null if no doc exists yet / still loading. */
  catalogue: DisplayModesCatalogue | null;
  /** Waiting for the first snapshot; resets when (siteId, machineId) change. */
  loading: boolean;
  /** Any error from the Firestore subscription; null while healthy. */
  error: string | null;
}

export interface UseDisplayModesOptions {
  /** False skips the subscription entirely — for components that only need the
   * catalogue in edit mode. Default true. */
  enabled?: boolean;
  /** Auto-fires `enumerateDisplayModes` when the catalogue's `signatureHash`
   * differs. Deduped to once per (site, machine, hash) per tab lifetime. */
  triggerForHash?: string | null;
}

interface InternalState {
  /** Tags state with its (site, machine) so late snapshots from a previous
   * target are discarded rather than leaking. Same as `useDisplayState`. */
  siteId: string;
  machineId: string;
  catalogue: DisplayModesCatalogue | null;
  loaded: boolean;
  error: string | null;
}

const INITIAL_STATE: InternalState = {
  siteId: '',
  machineId: '',
  catalogue: null,
  loaded: false,
  error: null,
};

/** Null on a missing or malformed doc — "no catalogue yet" beats crashing on a
 * partial write. */
function parseCatalogue(data: unknown): DisplayModesCatalogue | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const schemaVersion = typeof d.schemaVersion === 'number' ? d.schemaVersion : null;
  const signatureHash = typeof d.signatureHash === 'string' ? d.signatureHash : null;
  const capturedAt = typeof d.capturedAt === 'number' ? d.capturedAt : null;
  const byEdidRaw = d.byEdidHash;
  if (schemaVersion === null || signatureHash === null || capturedAt === null) {
    return null;
  }
  if (!byEdidRaw || typeof byEdidRaw !== 'object') return null;
  const byEdidHash: Record<string, DisplayModesEntry> = {};
  for (const [edid, raw] of Object.entries(byEdidRaw as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const modes: DisplayModeEntry[] = Array.isArray(entry.modes)
      ? entry.modes
          .filter(
            (m): m is DisplayModeEntry =>
              !!m &&
              typeof m === 'object' &&
              typeof (m as DisplayModeEntry).w === 'number' &&
              typeof (m as DisplayModeEntry).h === 'number' &&
              typeof (m as DisplayModeEntry).hz === 'number',
          )
          .map((m) => ({ w: m.w, h: m.h, hz: m.hz }))
      : [];
    const dpiScales: number[] = Array.isArray(entry.dpiScales)
      ? entry.dpiScales.filter((n): n is number => typeof n === 'number')
      : [];
    byEdidHash[edid] = { modes, dpiScales };
  }
  return { schemaVersion, signatureHash, capturedAt, byEdidHash };
}

export function useDisplayModes(
  siteId: string,
  machineId: string,
  options: UseDisplayModesOptions = {},
): UseDisplayModesResult {
  const { enabled = true, triggerForHash } = options;
  const [state, setState] = useState<InternalState>(INITIAL_STATE);
  const actions = useDisplayActions(siteId, machineId);

  // Per-session dedup so re-mounts and snapshot cascades don't re-dispatch.
  // A ref, not state — the assignment must not cause a re-render.
  const triggeredForHashRef = useRef<string | null>(null);
  // Resets the dedup when the caller swaps machines without unmounting.
  const lastTargetRef = useRef<string>('');

  useEffect(() => {
    if (!enabled || !db || !siteId || !machineId) {
      return;
    }

    // Target change clears the dedup so the new machine can trigger. The state
    // reset happens in the render-time derivation below (`state.siteId !==
    // siteId`) to avoid a setState outside a React event handler.
    const targetKey = `${siteId}:${machineId}`;
    if (lastTargetRef.current !== targetKey) {
      triggeredForHashRef.current = null;
      lastTargetRef.current = targetKey;
    }

    const ref = doc(
      db,
      'sites',
      siteId,
      'machines',
      machineId,
      'hardware',
      'displayModes',
    );
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const next = snap.exists() ? parseCatalogue(snap.data()) : null;
        // Stamped with its target so the derivation guard can discard it after
        // a switch; unconditional overwrite is safe because of the stamp.
        setState({
          siteId,
          machineId,
          catalogue: next,
          loaded: true,
          error: null,
        });
      },
      (err) => {
        console.error('Error subscribing to display modes catalogue:', err);
        setState({
          siteId,
          machineId,
          catalogue: null,
          loaded: true,
          error: err.message,
        });
      },
    );
    return unsubscribe;
  }, [siteId, machineId, enabled]);

  // Gated on `loaded` so a missing doc triggers only after the first snapshot
  // confirms "no cache", not speculatively on mount.
  const enumerateDisplayModes = actions.enumerateDisplayModes;
  useEffect(() => {
    if (!enabled) return;
    if (!triggerForHash) return;
    if (!state.loaded) return;
    if (state.siteId !== siteId || state.machineId !== machineId) return;
    if (triggeredForHashRef.current === triggerForHash) return;
    if (state.catalogue?.signatureHash === triggerForHash) {
      // Already matches: record the dedup, don't dispatch.
      triggeredForHashRef.current = triggerForHash;
      return;
    }
    triggeredForHashRef.current = triggerForHash;
    enumerateDisplayModes().catch((err) => {
      console.warn('Failed to dispatch enumerate_display_modes:', err);
      // Reset on failure so the next entry retries instead of silently blocking.
      if (triggeredForHashRef.current === triggerForHash) {
        triggeredForHashRef.current = null;
      }
    });
  }, [
    enabled,
    triggerForHash,
    state.loaded,
    state.catalogue?.signatureHash,
    state.siteId,
    state.machineId,
    siteId,
    machineId,
    enumerateDisplayModes,
  ]);

  // Render-time derivation, matching useDisplayState.
  if (!enabled) {
    return {
      catalogue: null,
      loading: false,
      error: null,
    };
  }
  if (!db) {
    return {
      catalogue: null,
      loading: false,
      error: 'Firebase not configured',
    };
  }
  if (!siteId || !machineId) {
    return {
      catalogue: null,
      loading: false,
      error: null,
    };
  }
  // Target in flight — report loading rather than leaking prior-target data.
  if (state.siteId !== siteId || state.machineId !== machineId) {
    return {
      catalogue: null,
      loading: true,
      error: null,
    };
  }
  return {
    catalogue: state.catalogue,
    loading: !state.loaded,
    error: state.error,
  };
}
