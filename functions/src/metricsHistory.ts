/**
 * Fans the agent's single machine-doc metrics write out into
 * `metrics_history/{bucket}` and evaluates threshold alert rules, so the agent
 * never has to write twice.
 *
 * Buckets are hourly UTC (`YYYY-MM-DD-HH`); legacy docs were daily
 * (`YYYY-MM-DD`) and readers still support both. 24 hourly docs keep 30-second
 * telemetry under Firestore's 1MiB document limit — the samples/meta shape is
 * unchanged. Appends via arrayUnion (atomic, no read-modify-write), with a 55s
 * duplicate-sample guard.
 */

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { metricsWriteDisposition } from './lib/metricsAlertLogic';
import { alertRulesOrDefault } from './lib/defaultAlertRules';
import https = require('https');
import http = require('http');

const db = getFirestore();

interface AlertRule {
  id: string;
  name: string;
  metric: string;
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  severity: string;
  channels: string[];
  enabled: boolean;
  cooldownMinutes: number;
}

interface CachedAlertRules {
  rules: AlertRule[];
  fetchedAt: number;
}

/** Module-level cache: siteId → cached rules (5-minute TTL) */
const alertRulesCache = new Map<string, CachedAlertRules>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve scalars from v2 (per-device maps + metrics.primary) or v1 (singular
 * cpu/disk/gpu) docs: primary device, else first entry, else the v1 field — so
 * in-flight docs mid-rollout still produce samples.
 */
function pickPrimaryEntry<T>(
  map: Record<string, T> | undefined,
  primaryId: string | null | undefined,
): T | undefined {
  if (!map) return undefined;
  if (primaryId && map[primaryId]) return map[primaryId];
  const first = Object.values(map)[0];
  return first;
}

function v2CpuPercent(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.cpus, m.primary?.cpu)?.percent ?? m.cpu?.percent;
}
function v2CpuTemp(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.cpus, m.primary?.cpu)?.temperature ?? m.cpu?.temperature;
}
function v2DiskPercent(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.disks, m.primary?.disk)?.percent ?? m.disk?.percent;
}
function v2GpuPercent(m: Record<string, any>): number | undefined {
  const v2 = pickPrimaryEntry<any>(m.gpus, m.primary?.gpu);
  return v2?.usagePercent ?? m.gpu?.usage_percent;
}
function v2GpuTemp(m: Record<string, any>): number | undefined {
  return pickPrimaryEntry<any>(m.gpus, m.primary?.gpu)?.temperature ?? m.gpu?.temperature;
}
function v2Latency(m: Record<string, any>): number | undefined {
  return m.network?.latencyMs ?? m.network?.latency_ms;
}
function v2PacketLoss(m: Record<string, any>): number | undefined {
  return m.network?.packetLossPct ?? m.network?.packet_loss_pct;
}

/** Metric name → path into the metrics object from the machine document */
const METRIC_PATHS: Record<string, (m: Record<string, any>) => number | undefined> = {
  cpu_percent:        v2CpuPercent,
  memory_percent:     (m) => m.memory?.percent,
  disk_percent:       v2DiskPercent,
  gpu_percent:        v2GpuPercent,
  cpu_temp:           v2CpuTemp,
  gpu_temp:           v2GpuTemp,
  network_latency:    v2Latency,
  network_packet_loss:v2PacketLoss,
};

/** Keys are abbreviated to keep the samples array under the 1MiB doc limit. */
interface NicSample {
  i: string;   // interface name
  tx: number;  // TX bytes/sec
  rx: number;  // RX bytes/sec
  tu: number;  // TX utilization % of link speed
  ru: number;  // RX utilization % of link speed
}

interface DiskSample {
  i: string;   // disk id (e.g. "C:", "L:")
  p: number;   // usage percent
}

interface GpuSample {
  i: string;   // gpu id (e.g. "GPU 0")
  u: number;   // usage percent
  t?: number;  // temperature (optional)
}

interface DiskIOSample {
  i: string;   // volume id (e.g. "C:", "L:")
  rb: number;  // read bytes/sec
  wb: number;  // write bytes/sec
  bu: number;  // busy %
  mb: number;  // max bytes/sec — denominator for read/write %-of-bandwidth chart
}

interface MetricsSample {
  t: number;   // timestamp (unix seconds)
  c: number;   // cpu percent
  m: number;   // memory percent
  d: number;   // disk percent
  g?: number;  // gpu percent (optional)
  ct?: number; // cpu temperature (optional)
  gt?: number; // gpu temperature (optional)
  n?: NicSample[]; // per-NIC network metrics (optional)
  ds?: DiskSample[]; // per-disk usage (optional)
  gs?: GpuSample[]; // per-GPU usage (optional)
  dios?: DiskIOSample[]; // per-volume disk IO (optional)
  nl?: number; // network latency ms (gateway ping, optional)
  np?: number; // network packet loss % (gateway ping, optional)
}

/** Appends a sample to the hourly history bucket on any machine-doc write. */
export const onMetricsWrite = onDocumentWritten(
  'sites/{siteId}/machines/{machineId}',
  async (event) => {
    const { siteId, machineId } = event.params;

    const afterData = event.data?.after?.data();
    if (!afterData) {
      console.log(`No data after write for ${machineId}, skipping`);
      return;
    }

    // Liveness gate (metricsAlertLogic.ts). This fires on EVERY machine-doc
    // write, not just telemetry — an offline machine keeps stale metrics frozen
    // and server-side writes (health-check cron) re-trigger us. Returning here,
    // before both sampling and alert eval, is what stops phantom samples and
    // hourly re-fires of "disk 87% > 85" for a machine offline all week.
    const disposition = metricsWriteDisposition(afterData, Date.now());
    if (disposition === 'skip-no-metrics') {
      console.log(`No metrics in write for ${machineId}, skipping`);
      return;
    }
    if (disposition === 'skip-stale') {
      console.log(`Stale telemetry for ${machineId}; skipping sample + alert eval`);
      return;
    }
    const metrics = afterData.metrics;

    const now = Math.floor(Date.now() / 1000);

    const sampleDate = new Date(now * 1000);
    const bucketId = hourlyBucketId(sampleDate);
    const previousBucketId = hourlyBucketId(new Date(sampleDate.getTime() - 60 * 60 * 1000));
    const legacyDayBucketId = dailyBucketId(sampleDate);

    const historyRef = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('metrics_history')
      .doc(bucketId);

    // 55s duplicate-sample guard. The first write into a new hour also consults
    // the previous hour and the legacy daily doc, so an hour or deploy boundary
    // can't slip a sample past the limit.
    try {
      const lastSampleTime = await readLastSampleTime(
        historyRef,
        db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('metrics_history')
          .doc(previousBucketId),
        db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('metrics_history')
          .doc(legacyDayBucketId),
      );

      if (lastSampleTime && now - lastSampleTime < 55) {
        console.log(`Rate limiting: last sample was ${now - lastSampleTime}s ago for ${machineId}`);
        return;
      }
    } catch (err) {
      // Unreadable metadata: sample anyway rather than lose the datapoint.
      console.warn(`Could not check rate limit for ${machineId}:`, err);
    }

    const cpuPct = v2CpuPercent(metrics);
    const memPct = metrics.memory?.percent;
    const diskPct = v2DiskPercent(metrics);
    const sample: MetricsSample = {
      t: now,
      c: round(cpuPct ?? 0),
      m: round(memPct ?? 0),
      d: round(diskPct ?? 0),
    };

    const gpuPct = v2GpuPercent(metrics);
    if (gpuPct !== undefined && gpuPct !== null) sample.g = round(gpuPct);

    const cpuTemp = v2CpuTemp(metrics);
    if (cpuTemp !== undefined && cpuTemp !== null) sample.ct = round(cpuTemp);

    const gpuTemp = v2GpuTemp(metrics);
    if (gpuTemp !== undefined && gpuTemp !== null) sample.gt = round(gpuTemp);

    const latency = v2Latency(metrics);
    if (latency !== undefined && latency !== null) sample.nl = round(latency);

    const packetLoss = v2PacketLoss(metrics);
    if (packetLoss !== undefined && packetLoss !== null) sample.np = round(packetLoss);

    // v2: metrics.nics[id] = { txBps, rxBps, txUtil, rxUtil }.
    // v1: metrics.network.interfaces[id] = { tx_bps, rx_bps, tx_util, rx_util }.
    const v2Nics = metrics.nics;
    const v1Nics = metrics.network?.interfaces;
    const nicEntries: NicSample[] = [];
    if (v2Nics && typeof v2Nics === 'object') {
      for (const [name, data] of Object.entries(v2Nics)) {
        const nic = data as Record<string, number>;
        if ((nic.txBps ?? 0) > 0 || (nic.rxBps ?? 0) > 0) {
          nicEntries.push({
            i: name,
            tx: Math.round(nic.txBps ?? 0),
            rx: Math.round(nic.rxBps ?? 0),
            tu: round(nic.txUtil ?? 0),
            ru: round(nic.rxUtil ?? 0),
          });
        }
      }
    } else if (v1Nics && typeof v1Nics === 'object') {
      for (const [name, data] of Object.entries(v1Nics)) {
        const nic = data as Record<string, number>;
        if ((nic.tx_bps ?? 0) > 0 || (nic.rx_bps ?? 0) > 0) {
          nicEntries.push({
            i: name,
            tx: Math.round(nic.tx_bps ?? 0),
            rx: Math.round(nic.rx_bps ?? 0),
            tu: round(nic.tx_util ?? 0),
            ru: round(nic.rx_util ?? 0),
          });
        }
      }
    }
    if (nicEntries.length > 0) sample.n = nicEntries;

    // v2: metrics.disks[id] = { percent, usedGb }.
    const v2Disks = metrics.disks;
    const diskEntries: DiskSample[] = [];
    if (v2Disks && typeof v2Disks === 'object') {
      for (const [id, data] of Object.entries(v2Disks)) {
        const disk = data as Record<string, number>;
        diskEntries.push({
          i: id,
          p: round(disk.percent ?? 0),
        });
      }
    }
    if (diskEntries.length > 0) sample.ds = diskEntries;

    // v2: metrics.gpus[id] = { name?, usagePercent, temperature?, vramUsedGb }.
    // Label with `name`; the map key is a UUID.
    const v2Gpus = metrics.gpus;
    const gpuEntries: GpuSample[] = [];
    if (v2Gpus && typeof v2Gpus === 'object') {
      for (const [id, data] of Object.entries(v2Gpus)) {
        const gpu = data as Record<string, any>;
        const entry: GpuSample = {
          i: (typeof gpu.name === 'string' && gpu.name) ? gpu.name : id,
          u: round(gpu.usagePercent ?? 0),
        };
        if (gpu.temperature != null) entry.t = round(gpu.temperature);
        gpuEntries.push(entry);
      }
    }
    if (gpuEntries.length > 0) sample.gs = gpuEntries;

    // v2: metrics.diskio[id] = { readBps, writeBps, readIops, writeIops, busyPct, maxBps }.
    const v2DiskIO = metrics.diskio;
    const diskIOEntries: DiskIOSample[] = [];
    if (v2DiskIO && typeof v2DiskIO === 'object' && !Array.isArray(v2DiskIO)) {
      for (const [id, data] of Object.entries(v2DiskIO)) {
        const vol = data as Record<string, number>;
        const rb = Number.isFinite(vol.readBps) ? Math.round(vol.readBps as number) : 0;
        const wb = Number.isFinite(vol.writeBps) ? Math.round(vol.writeBps as number) : 0;
        const bu = Number.isFinite(vol.busyPct) ? round(vol.busyPct as number) : 0;
        const mb = Number.isFinite(vol.maxBps) ? Math.round(vol.maxBps as number) : 0;
        if (rb > 0 || wb > 0 || bu > 0) {
          diskIOEntries.push({ i: id, rb, wb, bu, mb });
        }
      }
    }
    if (diskIOEntries.length > 0) sample.dios = diskIOEntries;

    try {
      await historyRef.set(
        {
          samples: FieldValue.arrayUnion(sample),
          meta: {
            lastSampleTime: now,
            updatedAt: FieldValue.serverTimestamp(),
            resolution: '1min',
          },
        },
        { merge: true }
      );

      console.log(`Historical sample recorded for ${machineId} in bucket ${bucketId}`);
    } catch (err) {
      console.error(`Failed to write historical sample for ${machineId}:`, err);
      throw err; // marks the function invocation failed
    }

    // Alert eval must not fail the function — the sample is already durable.
    try {
      await evaluateThresholdAlerts(siteId, machineId, metrics);
    } catch (err) {
      console.error(`Threshold alert evaluation failed for ${machineId}:`, err);
    }
  }
);

/** One decimal place. */
function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function hourlyBucketId(date: Date): string {
  return date.toISOString().slice(0, 13).replace('T', '-'); // YYYY-MM-DD-HH
}

function dailyBucketId(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function readLastSampleTime(
  currentHourRef: FirebaseFirestore.DocumentReference,
  previousHourRef: FirebaseFirestore.DocumentReference,
  legacyDayRef: FirebaseFirestore.DocumentReference,
): Promise<number | null> {
  const currentHourDoc = await currentHourRef.get();
  const currentLastSample = currentHourDoc.data()?.meta?.lastSampleTime;
  if (typeof currentLastSample === 'number') return currentLastSample;

  const [previousHourDoc, legacyDayDoc] = await Promise.all([
    previousHourRef.get(),
    legacyDayRef.get(),
  ]);

  const previousLastSample = previousHourDoc.data()?.meta?.lastSampleTime;
  const legacyLastSample = legacyDayDoc.data()?.meta?.lastSampleTime;
  const candidates = [previousLastSample, legacyLastSample].filter(
    (value): value is number => typeof value === 'number',
  );

  return candidates.length > 0 ? Math.max(...candidates) : null;
}

/** Alert rules for a site, or the default rules if it never saved any, via the 5-minute in-memory cache. */
async function getAlertRules(siteId: string): Promise<AlertRule[]> {
  const cached = alertRulesCache.get(siteId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rules;
  }

  const alertsDoc = await db.doc(`sites/${siteId}/settings/alerts`).get();
  const rules: AlertRule[] = [];

  for (const r of alertRulesOrDefault(alertsDoc.data()?.rules)) {
    const rule = r as Partial<AlertRule> | null;
    if (rule && typeof rule.id === 'string' && typeof rule.metric === 'string') {
      rules.push(rule as AlertRule);
    }
  }

  alertRulesCache.set(siteId, { rules, fetchedAt: Date.now() });
  return rules;
}

function isBreached(metricValue: number, operator: string, threshold: number): boolean {
  switch (operator) {
    case '>':  return metricValue > threshold;
    case '<':  return metricValue < threshold;
    case '>=': return metricValue >= threshold;
    case '<=': return metricValue <= threshold;
    default:   return false;
  }
}

/** Triggers a notification for each breached rule that isn't in cooldown. */
async function evaluateThresholdAlerts(
  siteId: string,
  machineId: string,
  metrics: Record<string, any>
): Promise<void> {
  const rules = await getAlertRules(siteId);
  if (rules.length === 0) return;

  const now = Math.floor(Date.now() / 1000);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const extractor = METRIC_PATHS[rule.metric];
    if (!extractor) continue;

    const metricValue = extractor(metrics);
    if (metricValue === undefined || metricValue === null) continue;

    if (!isBreached(metricValue, rule.operator, rule.value)) continue;

    const cooldownRef = db.doc(
      `sites/${siteId}/alert_cooldowns/${rule.id}_${machineId}`
    );

    try {
      const cooldownDoc = await cooldownRef.get();
      if (cooldownDoc.exists) {
        const lastTriggered = cooldownDoc.data()?.lastTriggered as number;
        if (lastTriggered && now - lastTriggered < rule.cooldownMinutes * 60) {
          continue; // Still in cooldown
        }
      }
    } catch (err) {
      console.warn(`Could not check cooldown for rule ${rule.id}:`, err);
    }

    // Stamp the cooldown before dispatching: a failed send must not re-fire.
    try {
      await cooldownRef.set({ lastTriggered: now });
    } catch (err) {
      console.warn(`Could not write cooldown for rule ${rule.id}:`, err);
    }

    try {
      await callAlertTriggerApi({
        siteId,
        machineId,
        ruleName: rule.name,
        metric: rule.metric,
        value: metricValue,
        threshold: rule.value,
        operator: rule.operator,
        severity: rule.severity,
        channels: rule.channels,
      });
      console.log(
        `Threshold alert triggered: ${rule.name} — ${rule.metric} ${metricValue} ${rule.operator} ${rule.value} on ${machineId}`
      );
    } catch (err) {
      console.error(`Failed to trigger alert for rule ${rule.id}:`, err);
    }
  }
}

/** Web API base URL from the project ID — avoids a dev/prod env var. */
function getApiBaseUrl(): string {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || '';
  if (projectId.includes('dev')) return 'https://dev.owlette.app';
  return 'https://owlette.app';
}

/** POST /api/alerts/trigger, over node http/https to keep functions dep-free. */
function callAlertTriggerApi(body: Record<string, unknown>): Promise<void> {
  const baseUrl = process.env.API_BASE_URL || getApiBaseUrl();
  const secret = process.env.CORTEX_INTERNAL_SECRET;

  if (!secret) {
    console.warn('CORTEX_INTERNAL_SECRET not configured — skipping alert trigger');
    return Promise.resolve();
  }

  const url = new URL('/api/alerts/trigger', baseUrl);
  const payload = JSON.stringify(body);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise<void>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-internal-secret': secret,
        },
        timeout: 10_000,
      },
      (res) => {
        res.resume(); // drain, or the socket leaks
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Alert trigger API returned status ${res.statusCode}`));
        }
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Alert trigger API request timed out'));
    });

    req.write(payload);
    req.end();
  });
}
