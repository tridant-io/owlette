'use client';

/**
 * Historical metrics for one machine, for MetricsDetailPanel's Day/Week/Month/Year/All charts.
 *
 * sites/{siteId}/machines/{machineId}/metrics_history/{YYYY-MM-DD}
 *   samples: [{ t, c, m, d, g, ct, gt }, ...]
 *   meta: { lastSample, sampleCount, resolution }
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { collection, getDocs, query, where, documentId, orderBy } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useDemoContext } from '@/contexts/DemoContext';
import {
  formatHourBucketId,
  formatDayBucketId,
  DAY_BUCKET_ID_RE,
  HOUR_BUCKET_ID_RE,
} from '@/lib/metricsHistoryBuckets';
import { downsampleTimeUniform, insertGapMarkers } from '@/lib/metricsDownsample';
import type { TimeRange } from '@/components/charts';

interface NicSample {
  i: string;   // interface name
  tx: number;  // TX bytes/sec
  rx: number;  // RX bytes/sec
  tu: number;  // TX % of link speed
  ru: number;  // RX % of link speed
}

interface DiskSample {
  i: string;   // disk id, e.g. "C:"
  p: number;   // usage percent
}

interface GpuSample {
  i: string;   // gpu id, e.g. "GPU 0"
  u: number;   // usage percent
  t?: number;  // temperature
}

interface DiskIOSample {
  i: string;   // volume id, e.g. "C:"
  rb: number;  // read bytes/sec
  wb: number;  // write bytes/sec
  bu: number;  // busy %
  mb?: number; // max bytes/sec — %-of-bandwidth denominator; absent on older samples
}

/** Raw Firestore sample; abbreviated keys. */
export interface MetricsSample {
  t: number;   // unix SECONDS
  c: number;   // cpu percent
  m: number;   // memory percent
  d: number;   // disk percent
  g?: number;  // gpu percent
  ct?: number; // cpu temperature
  gt?: number; // gpu temperature
  n?: NicSample[];
  ds?: DiskSample[];
  gs?: GpuSample[];
  dios?: DiskIOSample[];
}

/** Chart-ready point. Network keys are dynamic, e.g. Ethernet_tx / Ethernet_rx_util. */
export interface ChartDataPoint {
  time: number;     // unix MILLISECONDS
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  gpu?: number | null;
  cpuTemp?: number | null;
  gpuTemp?: number | null;
  [key: string]: number | null | undefined; // dynamic network keys
}

interface UseHistoricalMetricsResult {
  data: ChartDataPoint[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

function getStartDate(range: TimeRange): Date {
  const now = new Date();

  switch (range) {
    case '1h':
      return new Date(now.getTime() - 60 * 60 * 1000);
    case '1d':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case '1w':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case '1y':
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case 'all':
      return new Date(0); // Beginning of time
    default:
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}

const FIRESTORE_IN_LIMIT = 30;
const MAX_FETCHED_SAMPLES = 5000;
const MAX_DAY_BUCKET_IN_QUERIES = 24;

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Bucket IDs (YYYY-MM-DD) covering [start, end]. */
function getBucketIds(start: Date, end: Date): string[] {
  const ids: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    ids.push(formatDayBucketId(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return ids;
}

/** All-null point for insertGapMarkers to break the line across offline periods. */
function makeGapPoint(time: number): ChartDataPoint {
  return {
    time,
    cpu: null,
    memory: null,
    disk: null,
    gpu: null,
    cpuTemp: null,
    gpuTemp: null,
  };
}

/** Display cap per range — chart performance vs data density. */
const MAX_POINTS: Record<TimeRange, number> = {
  '1h': 120,  // all points, no downsampling
  '1d': 200,
  '1w': 300,
  '1m': 400,
  '1y': 500,
  'all': 600,
};

/**
 * Auto-refresh cadence while the panel stays open, per range. The hour chart moves visibly
 * minute to minute so it polls often; a day chart barely shifts, so it polls lazily. Week and
 * longer don't auto-refresh at all — a few missing minutes are invisible at that zoom and the
 * query spans far more buckets.
 */
const REFRESH_INTERVAL_MS: Partial<Record<TimeRange, number>> = {
  '1h': 2 * 60 * 1000,
  '1d': 5 * 60 * 1000,
};

export function useHistoricalMetrics(
  siteId: string | null,
  machineId: string | null,
  timeRange: TimeRange
): UseHistoricalMetricsResult {
  const demo = useDemoContext();
  const [data, setData] = useState<ChartDataPoint[] | null>(null);
  const [loading, setLoading] = useState(!demo);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);
  // bumped when the site, machine or range changes, so a read for the old one never lands
  const generation = useRef(0);

  const fetchData = useCallback(async (options?: { background?: boolean }) => {
    // A background refresh repaints in place: it never raises `loading` (which swaps the whole
    // panel body for a spinner) and never surfaces a transient error over a good chart — the
    // next tick retries.
    const background = options?.background === true;
    const request = generation.current;

    if (demo && machineId) {
      setData(demo.getHistoricalData(machineId, timeRange));
      setLoading(false);
      return;
    }

    if (!db) {
      if (background) return;
      setLoading(false);
      setError('Firebase not configured');
      setData(null);
      return;
    }
    if (!siteId || !machineId) {
      if (background) return;
      // Params not ready. Flipping loading=false here caused a "no data" flash pre-fetch.
      setLoading(true);
      setData(null);
      return;
    }

    if (!background) {
      setLoading(true);
      setError(null);
    }

    try {
      const now = new Date();
      const startDate = getStartDate(timeRange);
      const startTimestamp = Math.floor(startDate.getTime() / 1000);
      const endTimestamp = Math.floor(now.getTime() / 1000);

      const bucketIds = getBucketIds(startDate, now);

      const historyRef = collection(
        db,
        'sites',
        siteId,
        'machines',
        machineId,
        'metrics_history'
      );

      const allSamples: ChartDataPoint[] = [];
      const bucketDocs = new Map<string, { id: string; data: () => Record<string, unknown> }>();
      const fromDayId = formatDayBucketId(startDate);
      const toDayId = formatDayBucketId(now);
      const fromHourId = formatHourBucketId(startDate);
      const toHourId = formatHourBucketId(now);

      // Exact-ID fetch for normal ranges: no unbounded collection read, and no reads of
      // interleaved hour buckets. Huge "all" windows use a documentId range instead of
      // hundreds of `in` queries.
      if (bucketIds.length > 0 && bucketIds.length <= FIRESTORE_IN_LIMIT * MAX_DAY_BUCKET_IN_QUERIES) {
        for (const bucketChunk of chunkArray(bucketIds, FIRESTORE_IN_LIMIT)) {
          const daySnap = await getDocs(query(historyRef, where(documentId(), 'in', bucketChunk)));
          daySnap.forEach((docSnap) => {
            if (DAY_BUCKET_ID_RE.test(docSnap.id)) {
              bucketDocs.set(docSnap.id, docSnap);
            }
          });
        }
      } else {
        const daySnap = await getDocs(query(
          historyRef,
          where(documentId(), '>=', fromDayId),
          where(documentId(), '<=', toDayId),
          orderBy(documentId(), 'asc'),
        ));
        daySnap.forEach((docSnap) => {
          if (DAY_BUCKET_ID_RE.test(docSnap.id)) {
            bucketDocs.set(docSnap.id, docSnap);
          }
        });
      }

      // Hourly buckets are YYYY-MM-DD-HH; query that shape too so migrated machines render
      // without a collection scan.
      const hourSnap = await getDocs(query(
        historyRef,
        where(documentId(), '>=', fromHourId),
        where(documentId(), '<=', toHourId),
        orderBy(documentId(), 'asc'),
      ));
      hourSnap.forEach((docSnap) => {
        if (HOUR_BUCKET_ID_RE.test(docSnap.id)) {
          bucketDocs.set(docSnap.id, docSnap);
        }
      });

      const sortedBucketDocs = Array.from(bucketDocs.values())
        .sort((a, b) => a.id.localeCompare(b.id));

      for (const doc of sortedBucketDocs) {
        const bucketId = doc.id;
        if (!DAY_BUCKET_ID_RE.test(bucketId) && !HOUR_BUCKET_ID_RE.test(bucketId)) continue;

        const docData = doc.data();
        const samples = docData.samples || [];

        for (const sample of samples as MetricsSample[]) {
          if (sample.t >= startTimestamp && sample.t <= endTimestamp) {
            const point: ChartDataPoint = {
              time: sample.t * 1000, // seconds → ms
              cpu: sample.c,
              memory: sample.m,
              disk: sample.d,
              gpu: sample.g,
              cpuTemp: sample.ct,
              gpuTemp: sample.gt,
            };

            if (sample.n) {
              for (const nic of sample.n) {
                point[`${nic.i}_tx`] = nic.tx;
                point[`${nic.i}_rx`] = nic.rx;
                point[`${nic.i}_tx_util`] = nic.tu;
                point[`${nic.i}_rx_util`] = nic.ru;
              }
            }

            if (sample.ds) {
              for (const disk of sample.ds) {
                point[`${disk.i}_pct`] = disk.p;
              }
            }

            if (sample.gs) {
              for (const gpu of sample.gs) {
                point[`${gpu.i}_usage`] = gpu.u;
                if (gpu.t != null) point[`${gpu.i}_temp`] = gpu.t;
              }
            }

            // Lines plot % of the volume's max bandwidth (`mb`, a hardware-class estimate that
            // ratchets up on observed peaks) so they share the 0-100 axis. Raw bytes/sec ride
            // alongside on the hidden axis for human-readable tooltips — same pairing as NIC
            // `_tx` vs `_tx_util`. Drive-letter filter drops older `HarddiskVolumeN` samples.
            if (sample.dios) {
              for (const dio of sample.dios) {
                if (!/^[A-Z]:$/.test(dio.i)) continue;
                point[`${dio.i}_io_read`] = dio.rb;
                point[`${dio.i}_io_write`] = dio.wb;
                if (dio.mb && dio.mb > 0) {
                  point[`${dio.i}_io_read_pct`] = Math.min(100, (dio.rb / dio.mb) * 100);
                  point[`${dio.i}_io_write_pct`] = Math.min(100, (dio.wb / dio.mb) * 100);
                }
                // Already a percentage (PercentDiskTime).
                point[`${dio.i}_io_busy`] = dio.bu;
              }
            }

            allSamples.push(point);

            // Memory guard. MUST be time-uniform over the full window: buckets stream
            // oldest-first, so an index-stepped trim re-thins old data every pass while new
            // samples arrive at full density — that recency bias made month/year charts render
            // only their back half. Slot sampling is idempotent, so old data survives repeats.
            // For 'all', startDate is epoch 0, so anchor on the earliest sample instead.
            if (allSamples.length > MAX_FETCHED_SAMPLES * 2) {
              allSamples.sort((a, b) => a.time - b.time);
              const domainStart =
                timeRange === 'all' ? allSamples[0].time : startDate.getTime();
              allSamples.splice(
                0,
                allSamples.length,
                ...downsampleTimeUniform(allSamples, MAX_FETCHED_SAMPLES, domainStart, now.getTime())
              );
            }
          }
        }
      }

      allSamples.sort((a, b) => a.time - b.time);

      // Time-uniform over the same window the X-axis renders, so no part of the range is favoured.
      const maxPoints = MAX_POINTS[timeRange];
      const domainStart =
        timeRange === 'all' && allSamples.length > 0
          ? allSamples[0].time
          : startDate.getTime();
      const downsampled = downsampleTimeUniform(allSamples, maxPoints, domainStart, now.getTime());
      const finalData = insertGapMarkers(downsampled, makeGapPoint);

      if (request !== generation.current) return;
      setData(finalData);
      setError(null);
      lastFetchRef.current = Date.now();
    } catch (e: unknown) {
      console.error('Failed to fetch historical metrics:', e);
      if (!background && request === generation.current) {
        setError(e instanceof Error ? e.message : 'Failed to load chart data');
      }
    } finally {
      if (!background && request === generation.current) setLoading(false);
    }
  }, [siteId, machineId, timeRange, demo]);

  useEffect(() => {
    generation.current += 1;
    fetchData();
  }, [fetchData]);

  // Refetch on tab-visible so the chart's "now" boundary doesn't stay frozen at mount time;
  // 30s staleness gate avoids refetch spam on quick tab flips.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetchRef.current > 30_000) {
        fetchData({ background: true });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchData]);

  // Keep an open panel live indefinitely: poll on the range's cadence while the tab is visible.
  // Hidden tabs are skipped entirely (no wasted reads); the visibility handler above catches up
  // on return. `fetchData` changes identity with site/machine/range, which resets the timer.
  useEffect(() => {
    if (demo) return;
    const intervalMs = REFRESH_INTERVAL_MS[timeRange];
    if (!intervalMs) return;

    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData({ background: true });
    }, intervalMs);

    return () => window.clearInterval(id);
  }, [fetchData, timeRange, demo]);

  const refetch = useCallback(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch };
}
