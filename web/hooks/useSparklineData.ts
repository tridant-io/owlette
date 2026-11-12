'use client';

/**
 * Live sparkline data (last 60 samples, ~1h at 1-min resolution) for machine cards.
 *
 * Bucket shapes, mirroring useHistoricalMetrics: the cloud function writes hourly
 * UTC buckets `metrics_history/{YYYY-MM-DD-HH}`; legacy data and the e2e fixtures
 * use a daily `metrics_history/{YYYY-MM-DD}`. We subscribe to current + previous
 * hour (so the window stays full across the hour boundary) plus today's daily
 * bucket, merge, and keep the last 60. Listeners re-subscribe each hour so an
 * open tab doesn't freeze on a stale bucket.
 */

import { useState, useEffect } from 'react';
import { collection, query, where, documentId, onSnapshot, type Firestore } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import { formatHourBucketId, formatDayBucketId } from '@/lib/metricsHistoryBuckets';
import type { SparklineDataPoint } from '@/components/charts';

const HOUR_MS = 60 * 60 * 1000;
const MAX_SAMPLES = 60;

/** Raw sample as stored in a metrics_history bucket (abbreviated keys). */
interface RawSample {
  t: number;
  c?: number;
  m?: number;
  d?: number;
  g?: number;
}

function currentHourEpoch(): number {
  return Math.floor(Date.now() / HOUR_MS);
}

function msUntilNextHour(): number {
  return HOUR_MS - (Date.now() % HOUR_MS);
}

/**
 * Re-derive an hour epoch at every UTC hour boundary so subscriptions closing over
 * a bucket id are recreated for the new hour. No timer when `active` is false.
 */
function useHourEpoch(active: boolean): number {
  const [epoch, setEpoch] = useState<number>(() => currentHourEpoch());
  useEffect(() => {
    if (!active) return;
    // +2s buffer so we're safely inside the new hour before recomputing ids.
    const timer = setTimeout(() => setEpoch(currentHourEpoch()), msUntilNextHour() + 2000);
    return () => clearTimeout(timer);
  }, [active, epoch]);
  return epoch;
}

/**
 * Subscribe to the buckets that can hold the last hour (current + previous hourly
 * plus today's legacy daily), merge deduped by timestamp, and deliver the newest
 * 60 samples ascending. Returns an unsubscribe.
 *
 * One `documentId() in [...]` listener covers all three buckets (one per machine,
 * not three). Only the current-hour doc changes minute to minute, so steady-state
 * traffic is unchanged.
 */
function subscribeLastHourSamples(
  database: Firestore,
  siteId: string,
  machineId: string,
  onSamples: (samples: RawSample[]) => void,
): () => void {
  const now = new Date();
  const bucketIds = [
    formatHourBucketId(new Date(now.getTime() - HOUR_MS)), // previous hour
    formatHourBucketId(now),                               // current hour
    formatDayBucketId(now),                                // legacy / e2e daily
  ];

  const historyRef = collection(database, 'sites', siteId, 'machines', machineId, 'metrics_history');
  const bucketsQuery = query(historyRef, where(documentId(), 'in', bucketIds));

  return onSnapshot(
    bucketsQuery,
    (snapshot) => {
      // Dedupe by timestamp, defensive against daily/hourly overlap. Results
      // iterate in documentId order, so the daily bucket ("YYYY-MM-DD") is
      // visited before the hourly ones — hourly wins any tie.
      const byTime = new Map<number, RawSample>();
      snapshot.forEach((docSnap) => {
        const samples = (docSnap.data()?.samples ?? []) as RawSample[];
        for (const s of samples) {
          if (s && typeof s.t === 'number') byTime.set(s.t, s);
        }
      });
      const merged = Array.from(byTime.values())
        .sort((a, b) => a.t - b.t)
        .slice(-MAX_SAMPLES);
      onSamples(merged);
    },
    (error) => {
      console.error('Error listening to sparkline data:', error);
      onSamples([]);
    },
  );
}

/** Stable empty array so consumers' memo/effect deps don't churn. */
const EMPTY_SPARKLINE: SparklineDataPoint[] = [];

interface AllSparklineState {
  cpu: SparklineDataPoint[];
  memory: SparklineDataPoint[];
  disk: SparklineDataPoint[];
  gpu: SparklineDataPoint[];
  loading: boolean;
}

/** All four metrics for one machine in a single subscription — cheaper than four hooks. */
export function useAllSparklineData(
  siteId: string | null,
  machineId: string | null
): AllSparklineState {
  const demo = useDemoContext();
  // loadedKey pins the data to the (siteId, machineId) it was loaded for, so
  // loading is derived at render with no sync setState on a key change.
  const [state, setState] = useState<{
    cpu: SparklineDataPoint[];
    memory: SparklineDataPoint[];
    disk: SparklineDataPoint[];
    gpu: SparklineDataPoint[];
    loadedKey: string | null;
  }>({ cpu: [], memory: [], disk: [], gpu: [], loadedKey: null });

  const currentKey = !demo && db && siteId && machineId ? `${siteId}/${machineId}` : null;
  const hourEpoch = useHourEpoch(currentKey !== null);

  useEffect(() => {
    // Demo mode is handled at render — the synthesized topology is pure and cheap
    // to recompute, so it never enters state.
    if (demo) return;
    if (!currentKey || !db || !siteId || !machineId) return;

    const unsubscribe = subscribeLastHourSamples(db, siteId, machineId, (samples) => {
      const cpu: SparklineDataPoint[] = [];
      const memory: SparklineDataPoint[] = [];
      const disk: SparklineDataPoint[] = [];
      const gpu: SparklineDataPoint[] = [];

      for (const s of samples) {
        cpu.push({ t: s.t, v: s.c ?? 0 });
        memory.push({ t: s.t, v: s.m ?? 0 });
        disk.push({ t: s.t, v: s.d ?? 0 });
        if ((s.g ?? 0) > 0) gpu.push({ t: s.t, v: s.g as number });
      }

      // Single setState — one re-render instead of five.
      setState({ cpu, memory, disk, gpu, loadedKey: currentKey });
    });

    return () => unsubscribe();
    // hourEpoch re-subscribes the listeners at each hour boundary.
  }, [currentKey, siteId, machineId, demo, hourEpoch]);

  if (demo && machineId) return { ...demo.getSparklineData(machineId) };
  // Surface only data matching the requested key. db unconfigured → nothing to
  // wait for. Ids unresolved (currentKey null) → stay loading so the card doesn't
  // flash "no data" before the subscription attaches.
  const matched = currentKey !== null && state.loadedKey === currentKey;
  return {
    cpu: matched ? state.cpu : EMPTY_SPARKLINE,
    memory: matched ? state.memory : EMPTY_SPARKLINE,
    disk: matched ? state.disk : EMPTY_SPARKLINE,
    gpu: matched ? state.gpu : EMPTY_SPARKLINE,
    loading: !demo && !!db && !matched,
  };
}
