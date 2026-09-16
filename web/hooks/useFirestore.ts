'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import {
  collection,
  collectionGroup,
  onSnapshot,
  doc,
  getDoc,
  query,
  where,
  Timestamp,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { logger } from '@/lib/logger';

/** Every shape a Firestore timestamp field arrives in on the client. parseFirestoreSeconds handles all of them. */
export type FirestoreTs =
  | Timestamp
  | number
  | { seconds: number; nanoseconds?: number }
  | { _seconds: number; _nanoseconds?: number }
  | string
  | Date
  | null
  | undefined;

/** FirestoreTs -> epoch ms for sort comparisons. Bare numbers are ms (Date.now()); 0 if unparseable. */
export function firestoreTsToMs(ts: FirestoreTs): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof ts === 'object') {
    const v = ts as { toMillis?: () => number; seconds?: number; _seconds?: number };
    if (typeof v.toMillis === 'function') {
      try { return v.toMillis(); } catch { return 0; }
    }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
  }
  return 0;
}

/**
 * FirestoreTs -> Unix seconds; 0 means "no value" (renders `--`, isOnline false).
 * Must handle every shape the JS SDK emits: cache rehydration yields plain
 * {seconds,nanoseconds}, which an earlier Timestamp-only parser silently dropped
 * and made the dashboard online pill flap.
 */
function parseFirestoreSeconds(value: unknown): number {
  if (value == null) return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'object') {
    const v = value as {
      toMillis?: () => number;
      seconds?: number;
      _seconds?: number;
    };
    if (typeof v.toMillis === 'function') {
      try {
        const ms = v.toMillis();
        return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
      } catch {
        // fall through to property reads
      }
    }
    if (typeof v.seconds === 'number') return v.seconds;
    // legacy admin-SDK shape
    if (typeof v._seconds === 'number') return v._seconds;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  }

  // some Firestore paths hand back ISO strings
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }

  return 0;
}

/**
 * Non-2xx from {@link apiJson}. Carries status + RFC-7807 `code` so callers can
 * tell an expected 401/403 from a real fault and keep it out of Sentry.
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

/** True for expected authorization outcomes that should not be logged as errors. */
function isExpectedAuthzError(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

async function apiJson<T>(
  url: string,
  init: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      body?.detail || body?.title || `Request failed with ${res.status}`,
      body?.code,
    );
  }
  return body as T;
}

function makeIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type LaunchMode = 'off' | 'always' | 'scheduled';

export interface TimeRange {
  start: string; // "HH:MM"
  stop: string;  // "HH:MM"
}

export interface ScheduleBlock {
  name?: string;       // Optional custom name (e.g. 'Morning shift')
  colorIndex?: number; // Stable color assignment (persists when blocks are deleted)
  days: string[];      // e.g. ['mon', 'tue', 'wed', 'thu', 'fri']
  ranges: TimeRange[];
}

/** A single scheduled restart entry — fires once per matching day at the given time. */
export interface RestartScheduleEntry {
  id: string;       // crypto.randomUUID() at creation, stable across edits
  days: string[];   // e.g. ['mon','tue','wed','thu','fri']
  time: string;     // "HH:MM" 24h
}

export interface RestartSchedule {
  enabled: boolean;
  entries: RestartScheduleEntry[];
}

export interface Process {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  autolaunch: boolean;
  launch_mode?: LaunchMode;
  schedules?: ScheduleBlock[] | null;
  schedulePresetId?: string | null;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  responsive: boolean;
  last_updated: number;
  index: number; // Order from config file
  // For optimistic UI updates
  _optimisticAutolaunch?: boolean;
  _optimisticLaunchMode?: LaunchMode;
  _optimisticSchedules?: ScheduleBlock[] | null;
  _optimisticPresetId?: string | null;
}

/** Static CPU hardware profile attached to a machine. */
export interface CpuProfile {
  id: string;              // "CPU0", "CPU1", ...
  model: string;
  physicalCores: number;
  logicalCores: number;
  socketIndex: number;
}

export interface DiskProfile {
  id: string;              // mountpoint, e.g. "C:"
  label: string;
  fs: string;
  totalGb: number;
}

export interface GpuProfile {
  id: string;              // UUID or hash
  name: string;
  vramTotalGb: number;
  pciBus: string | null;
}

export interface NicProfile {
  id: string;              // interface name, e.g. "Ethernet 2"
  mac: string | null;
  linkSpeedMbps: number;
}

export interface HardwareProfile {
  schemaVersion: number;
  signatureHash: string;
  capturedAt: FirestoreTs;
  agentVersion: string;
  cpus: CpuProfile[];
  disks: DiskProfile[];
  gpus: GpuProfile[];
  nics: NicProfile[];
}

export interface CpuMetric   { percent: number; temperature?: number | null }
export interface MemoryMetric { percent: number; usedGb: number }
export interface DiskMetric  { percent: number; usedGb: number }
export interface GpuMetric   { usagePercent: number; vramUsedGb: number; temperature?: number | null }
export interface NicMetric   { txBps: number; rxBps: number; txUtil: number; rxUtil: number }
export interface NetworkMetric { latencyMs?: number | null; packetLossPct?: number | null; gatewayIp?: string | null }

export interface PrimaryDevices {
  cpu?: string | null;
  disk?: string | null;
  gpu?: string | null;
  nic?: string | null;
}

/**
 * Joined view of a profiled device (CPU / disk / GPU / NIC) with its live metric.
 * `isMissing`: profiled but absent from the latest metrics upload.
 * `isOrphan`: metric with no profile entry (hardware changed since capture) —
 * carries only a synthesized profile shell, hence `Partial<P>`.
 */
export type DeviceEntry<P, M> = Partial<P> & Partial<M> & {
  id: string;
  isMissing: boolean;
  isOrphan: boolean;
};

export interface Machine {
  machineId: string;
  lastHeartbeat: number;
  online: boolean;
  agent_version?: string;  // Agent version for update detection (e.g., "2.0.0")
  machineTimezone?: string;  // IANA tz from the agent's tzlocal lookup; undefined on pre-IANA agent builds.
  cortexEnabled?: boolean;  // kill switch for Hoot tool-call delivery; undefined = enabled.
  /**
   * Agent-written capability handshake: the version of each remote operation
   * this agent can dispatch (`displayRemoteApply` gates the display panel's
   * restore). Undefined on agents predating the map, which reads as unsupported.
   */
  capabilities?: Record<string, number>;
  // `reboot*` are agent-written wire contracts; the legacy spelling is deliberate (UI says "restart").
  rebooting?: boolean;
  shuttingDown?: boolean;
  rebootScheduledAt?: number;    // Unix seconds — countdown anchor (matches lastHeartbeat convention)
  shutdownScheduledAt?: number;
  rebootPending?: {
    active: boolean;
    processName: string | null;
    reason: string | null;
    timestamp: number | null;
  };
  rebootSchedule?: RestartSchedule;
  /**
   * Mirrors `displays.autoRestore.circuitBreaker.tripped` from the config doc,
   * streamed by the existing collection-wide config listener (no per-card subs).
   * Undefined when the agent has auto-restore off.
   */
  displayBreakerTripped?: boolean;
  rebootState?: {
    lastFiredByEntry?: { [entryId: string]: string }; // ISO date "YYYY-MM-DD"
    attempt?: {
      entryId: string;
      scheduledFor: string;       // ISO instant
      lastAttemptAt: FirestoreTs;
      status: 'pending' | 'failed';
    } | null;
  };
  lastScreenshot?: {
    url: string;       // Firebase Storage public URL
    timestamp: FirestoreTs;
    sizeKB: number;
  };
  liveView?: {
    active: boolean;
    interval?: number;
    startedAt?: number;
    expiresAt?: number;
  };
  metrics?: {
    schemaVersion?: number;
    profileHash?: string;
    timestamp?: FirestoreTs;
    cpus?:   Record<string, CpuMetric>;
    memory?: MemoryMetric;
    disks?:  Record<string, DiskMetric>;
    gpus?:   Record<string, GpuMetric>;
    nics?:   Record<string, NicMetric>;
    network?: NetworkMetric & {
      /** @deprecated v1 legacy — per-interface map moved to top-level `metrics.nics` in v2. Kept for rollout-window shim. */
      interfaces?: Record<string, {
        tx_bps: number;
        rx_bps: number;
        tx_util: number;
        rx_util: number;
        link_speed: number;
      }>;
      /** @deprecated v1 legacy — use `gatewayIp` (v2). */
      gateway_ip?: string | null;
      /** @deprecated v1 legacy — use `latencyMs` (v2). */
      latency_ms?: number | null;
      /** @deprecated v1 legacy — use `packetLossPct` (v2). */
      packet_loss_pct?: number | null;
    };
    primary?: PrimaryDevices;
    processes?: Record<string, string>;

    /**
     * Monitors whose live config differs from the assigned layout (matched by
     * edidHash). Computed agent-side so the dashboard can draw the drift dot
     * without per-row displayProfiles/displayAssignments subs. Absent = 0.
     */
    displayDriftCount?: number;

    /** Per-volume disk IO keyed like `disks` (e.g. `"C:"`), 1:1 with it. Agents >= v2.8.2. */
    diskio?: Record<string, {
      readBps: number;
      writeBps: number;
      readIops: number;
      writeIops: number;
      busyPct: number;
    }>;

    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    cpu?: { name?: string; percent: number; unit: string; temperature?: number };
    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    disk?: { percent: number; total_gb: number; used_gb: number; unit: string };
    /** @deprecated v1 legacy singular field — kept for rollout-window shim. Remove once all agents are >= 2.9.0. */
    gpu?: { name: string; usage_percent: number; vram_total_gb: number; vram_used_gb: number; unit: string; temperature?: number };
  };
  profile?: HardwareProfile;
  /** Joined profile + metrics view; filled by `useMachines` once both have arrived. */
  devices?: {
    cpus: DeviceEntry<CpuProfile, CpuMetric>[];
    disks: DeviceEntry<DiskProfile, DiskMetric>[];
    gpus: DeviceEntry<GpuProfile, GpuMetric>[];
    nics: DeviceEntry<NicProfile, NicMetric>[];
  };
  processes?: Process[];
}

export interface Site {
  id: string;
  name: string;
  createdAt: FirestoreTs;
  timezone?: string;  // IANA timezone, e.g., "America/New_York"
  owner?: string;  // UID of the user who owns this site
  /**
   * Whether process schedules are evaluated in the site's timezone instead of
   * each machine's own clock. Three states, and `undefined` is a real one:
   * `undefined` = never asked (legacy sites; schedules stay machine-local),
   * `false` = the operator declined, `true` = site time. Do not collapse
   * `undefined` into `false` — that is what distinguishes a site still owed the
   * opt-in prompt from one that already answered no.
   */
  schedulesFollowSiteTime?: boolean;
}

// DELETE once all agents are >= 2.9.0
const LEGACY_METRICS_SHIM = true;

/**
 * Synthesize v2-shaped `metrics`/`profile` from a legacy (schemaVersion < 2) doc
 * so downstream code can always assume v2. Returns the input unchanged if already v2.
 */
function shimLegacyMachine(machine: Machine): Machine {
  if (!LEGACY_METRICS_SHIM) return machine;

  const legacy = machine.metrics;
  if (!legacy) return machine;
  if (legacy.schemaVersion === 2) return machine;
  // no legacy singular field = placeholder metrics, nothing to synthesize
  if (!legacy.cpu) return machine;

  const legacyNetwork = legacy.network ?? {};
  const legacyInterfaces = legacyNetwork.interfaces ?? {};
  const firstNicId = Object.keys(legacyInterfaces)[0];

  const cpus: Record<string, CpuMetric> = {
    CPU0: {
      percent: legacy.cpu.percent,
      temperature: legacy.cpu.temperature ?? null,
    },
  };

  const disks: Record<string, DiskMetric> = legacy.disk
    ? { 'C:': { percent: legacy.disk.percent, usedGb: legacy.disk.used_gb } }
    : {};

  const gpus: Record<string, GpuMetric> = legacy.gpu
    ? {
        GPU0: {
          usagePercent: legacy.gpu.usage_percent,
          vramUsedGb: legacy.gpu.vram_used_gb,
          temperature: legacy.gpu.temperature ?? null,
        },
      }
    : {};

  const nics: Record<string, NicMetric> = {};
  for (const [id, n] of Object.entries(legacyInterfaces)) {
    nics[id] = {
      txBps: n.tx_bps,
      rxBps: n.rx_bps,
      txUtil: n.tx_util,
      rxUtil: n.rx_util,
    };
  }

  // Legacy memory is snake_case at runtime despite the camelCase TS type (which
  // describes the post-shim shape) — read structurally and normalize.
  const legacyMemory = legacy.memory as unknown as
    | { percent: number; used_gb?: number; usedGb?: number }
    | undefined;
  const memory: MemoryMetric | undefined = legacyMemory
    ? {
        percent: legacyMemory.percent,
        usedGb: legacyMemory.used_gb ?? legacyMemory.usedGb ?? 0,
      }
    : undefined;

  const network: NetworkMetric = {
    latencyMs: legacyNetwork.latency_ms ?? null,
    packetLossPct: legacyNetwork.packet_loss_pct ?? null,
    gatewayIp: legacyNetwork.gateway_ip ?? null,
  };

  const primary: PrimaryDevices = {
    cpu: 'CPU0',
    disk: legacy.disk ? 'C:' : null,
    gpu: legacy.gpu ? 'GPU0' : null,
    nic: firstNicId ?? null,
  };

  const shimmedMetrics: Machine['metrics'] = {
    ...legacy,
    schemaVersion: 2,
    cpus,
    disks,
    gpus,
    nics,
    memory,
    network,
    primary,
  };

  const shimmedProfile: HardwareProfile = {
    schemaVersion: 0,
    signatureHash: 'legacy',
    capturedAt: 0,
    agentVersion: 'legacy',
    cpus: [{
      id: 'CPU0',
      model: legacy.cpu.name || 'Unknown',
      physicalCores: 0,
      logicalCores: 0,
      socketIndex: 0,
    }],
    disks: legacy.disk
      ? [{ id: 'C:', label: 'System', fs: 'NTFS', totalGb: legacy.disk.total_gb }]
      : [],
    gpus: legacy.gpu
      ? [{
          id: 'GPU0',
          name: legacy.gpu.name,
          vramTotalGb: legacy.gpu.vram_total_gb,
          pciBus: null,
        }]
      : [],
    nics: Object.entries(legacyInterfaces).map(([id, n]) => ({
      id,
      mac: null,
      linkSpeedMbps: n.link_speed,
    })),
  };

  // Preserve a real profile if one exists (v2 agent mid-rollout can upload a
  // profile doc while still writing legacy-shaped metrics).
  return {
    ...machine,
    metrics: shimmedMetrics,
    profile: machine.profile ?? shimmedProfile,
  };
}

/** Join `metrics` with `profile` into `devices`; flags isMissing / isOrphan. */
function joinMachineDevices(machine: Machine): Machine {
  const metrics = machine.metrics;
  const profile = machine.profile ?? (
    metrics
      ? {
          schemaVersion: 0,
          signatureHash: 'metric-only',
          capturedAt: 0,
          agentVersion: machine.agent_version ?? 'unknown',
          cpus: Object.keys(metrics.cpus ?? {}).map((id, index) => ({
            id,
            model: id,
            physicalCores: 0,
            logicalCores: 0,
            socketIndex: index,
          })),
          disks: [],
          gpus: Object.keys(metrics.gpus ?? {}).map((id) => ({
            id,
            name: id,
            vramTotalGb: 0,
            pciBus: null,
          })),
          nics: Object.keys(metrics.nics ?? {}).map((id) => ({
            id,
            mac: null,
            linkSpeedMbps: 0,
          })),
        } satisfies HardwareProfile
      : undefined
  );
  if (!profile) return machine;

  const buildBucket = <P extends { id: string }, M>(
    profileList: P[] | undefined,
    metricMap: Record<string, M> | undefined,
  ): DeviceEntry<P, M>[] => {
    const result: DeviceEntry<P, M>[] = [];
    const seen = new Set<string>();
    for (const p of profileList ?? []) {
      const metric = metricMap?.[p.id];
      result.push({
        ...p,
        ...(metric ?? {}),
        isMissing: !metric,
        isOrphan: false,
      } as unknown as DeviceEntry<P, M>);
      seen.add(p.id);
    }
    // orphans: metric keys absent from the profile
    for (const [id, metric] of Object.entries(metricMap ?? {})) {
      if (seen.has(id)) continue;
      result.push({
        id,
        ...(metric as M),
        isMissing: false,
        isOrphan: true,
      } as unknown as DeviceEntry<P, M>);
    }
    return result;
  };

  const devices = {
    cpus: buildBucket<CpuProfile, CpuMetric>(profile.cpus, metrics?.cpus),
    disks: buildBucket<DiskProfile, DiskMetric>(profile.disks, metrics?.disks),
    gpus: buildBucket<GpuProfile, GpuMetric>(profile.gpus, metrics?.gpus),
    nics: buildBucket<NicProfile, NicMetric>(profile.nics, metrics?.nics),
  };

  return { ...machine, devices };
}

/** Per-site role held on `sites/{siteId}/members/{uid}`. */
export type SiteRole = 'owner' | 'admin' | 'member';

const SITE_ROLES: readonly string[] = ['owner', 'admin', 'member'];

export interface SiteMemberships {
  /** siteId -> the caller's role there. Empty until the listener first resolves. */
  roleMap: Map<string, SiteRole>;
  loading: boolean;
  /**
   * Non-null when the listener was refused or failed.
   *
   * Deliberately surfaced rather than swallowed: a permission-denied that
   * renders as an empty list is indistinguishable from genuinely having no
   * sites, and "create your first site" shown to a user who has several is the
   * exact shape of the two access regressions this migration exists to end.
   */
  error: string | null;
}

function roleMapsEqual(a: Map<string, SiteRole>, b: Map<string, SiteRole>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * The caller's site memberships, live.
 *
 * ONE `collectionGroup` listener replaces walking `users/{uid}.sites[]` and
 * reading each site document to discover standing. The query filters on the
 * `uid` FIELD, not the document id, because that is the term Firestore can prove
 * against the rules — see the recursive members block in `firestore.rules`, which
 * is also what makes a collection-group query legal at all.
 *
 * No composite index is needed: a single-field equality is covered by automatic
 * single-field indexing at collection-group scope. Role is filtered in memory,
 * over tens of documents.
 */
export function useSiteMemberships(userId?: string): SiteMemberships {
  const [roleMap, setRoleMap] = useState<Map<string, SiteRole>>(() => new Map());
  // `db` is a module constant, so its absence is knowable at first render.
  const [loading, setLoading] = useState(Boolean(db));
  const [error, setError] = useState<string | null>(db ? null : 'Firebase not configured');
  const [subscribedUid, setSubscribedUid] = useState<string | undefined>(userId);

  // Reset during render, not in the effect: React's documented way to adjust
  // state when a prop changes, and it avoids the cascading render an effect-body
  // setState causes. It also fixes what a reset-in-effect would miss — on sign-out
  // `userId` goes undefined and the effect returns early, so without this the map
  // would keep publishing the previous user's sites.
  if (subscribedUid !== userId) {
    setSubscribedUid(userId);
    setRoleMap(new Map());
    setLoading(Boolean(db));
    setError(db ? null : 'Firebase not configured');
  }

  useEffect(() => {
    // Nothing to subscribe to; the state above already says so.
    if (!db) return;
    // Auth still resolving. `loading` is already true and no listener has
    // published — publishing an empty map here would read downstream as
    // "this user has no sites".
    if (!userId) return;

    const membershipQuery = query(
      collectionGroup(db, 'members'),
      where('uid', '==', userId),
    );

    const unsubscribe = onSnapshot(
      membershipQuery,
      (snapshot) => {
        const next = new Map<string, SiteRole>();
        snapshot.forEach((memberDoc) => {
          // sites/{siteId}/members/{uid} — the grandparent is the site.
          const siteId = memberDoc.ref.parent.parent?.id;
          if (!siteId) return;
          const data = memberDoc.data();
          if (data.status !== 'active') return;
          if (typeof data.role !== 'string' || !SITE_ROLES.includes(data.role)) return;
          next.set(siteId, data.role as SiteRole);
        });
        setRoleMap((prev) => (roleMapsEqual(prev, next) ? prev : next));
        setLoading(false);
      },
      (err) => {
        console.error('[membership] collectionGroup listener failed:', err);
        setError(err.message);
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [userId]);

  return { roleMap, loading, error };
}

export interface MembershipUnion {
  /** Site ids from membership and the legacy array, deduplicated and sorted. */
  sites: string[];
  /** Sites the legacy array grants but membership does not. Must reach zero. */
  fallbacks: string[];
}

/**
 * Union the membership map with the legacy `users/{uid}.sites[]` for one release.
 *
 * Publishing the union means a user whose backfill has not landed keeps working,
 * and `fallbacks` is the measurement that says when it has: every entry is a site
 * the legacy field grants and membership does not. Wave 6 strips the legacy field
 * only once that counter has held at zero — a number, not someone's reading of a
 * dry-run.
 *
 * Pure so it can be tested without a Firestore listener.
 */
export function unionMembership(
  roleMap: Map<string, SiteRole>,
  legacySites: string[],
): MembershipUnion {
  const fallbacks = legacySites.filter((siteId) => !roleMap.has(siteId));
  const sites = Array.from(new Set([...roleMap.keys(), ...legacySites])).sort();
  return { sites, fallbacks };
}

export function useSites(userId?: string, userSites?: string[], isSuperadmin?: boolean) {
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!db) {
      setLoading(false);
      setError('Firebase not configured');
      return;
    }

    // Wait for access to resolve. AuthContext publishes `userSites` as undefined
    // until the user doc AND membership listener have both delivered — before
    // that `isSuperadmin` can still be a not-yet-read `false`.
    if (userSites === undefined || isSuperadmin === undefined || userId === undefined) {
      setLoading(true);
      return;
    }

    // Do NOT remove: re-arms loading when access changes after it first
    // resolves (a role change swaps branches, a membership adds a site), so the
    // empty branch below can't latch loading=false over a list still arriving —
    // the "create your first site" flicker.
    setLoading(true);

    try {
      // superadmins see every site
      if (isSuperadmin) {
        const sitesRef = collection(db, 'sites');
        const unsubscribe = onSnapshot(
          sitesRef,
          (snapshot) => {
            const siteData: Site[] = [];
            snapshot.forEach((doc) => {
              const data = doc.data();
              siteData.push({
                id: doc.id,
                name: data.name || doc.id,
                createdAt: data.createdAt || Date.now(),
                timezone: data.timezone,
                owner: data.owner,
                // Stays `undefined` when the field is absent — the third state.
                schedulesFollowSiteTime:
                  typeof data.schedulesFollowSiteTime === 'boolean'
                    ? data.schedulesFollowSiteTime
                    : undefined,
              });
            });
            siteData.sort((a, b) => a.name.localeCompare(b.name));
            console.log('👑 Superadmin - loaded all sites:', siteData.map(s => s.id));
            setSites(siteData);
            setLoading(false);
          },
          (err) => {
            console.error('Error fetching sites:', err);
            setError(err.message);
            setLoading(false);
          }
        );
        return () => unsubscribe();
      }

      // Fetch assigned sites one doc at a time: collection queries fail because
      // the Firestore rules use get(), which rules can't evaluate for queries.
      const unsubscribes: (() => void)[] = [];
      const siteDataMap = new Map<string, Site>();
      // Sites whose listener has answered at least once (data, absence, or error),
      // against the distinct ids asked for — a repeated id must not hold it open.
      const reported = new Set<string>();
      const expected = new Set(userSites).size;

      // Nothing is published until EVERY listener has answered. The snapshots
      // land in any order, and a partial list with loading=false reads as the
      // whole list: callers resolved their default site against it, missed
      // `lastSiteId` because its snapshot hadn't arrived, and took `sites[0]`.
      const updateStateFromMap = () => {
        if (reported.size < expected) return;
        const siteArray = Array.from(siteDataMap.values());
        siteArray.sort((a, b) => a.name.localeCompare(b.name));
        setSites(siteArray);
        setLoading(false);
      };

      if (userSites.length === 0) {
        // clear stale sites from a previous userSites value
        setSites([]);
        setLoading(false);
      }

      userSites.forEach((siteId) => {
        const siteDocRef = doc(db!, 'sites', siteId);
        const unsubscribe = onSnapshot(
          siteDocRef,
          (docSnap) => {
            if (docSnap.exists()) {
              const data = docSnap.data();
              siteDataMap.set(siteId, {
                id: siteId,
                name: data.name || siteId,
                createdAt: data.createdAt || Date.now(),
                timezone: data.timezone,
                owner: data.owner,
                // Stays `undefined` when the field is absent — the third state.
                schedulesFollowSiteTime:
                  typeof data.schedulesFollowSiteTime === 'boolean'
                    ? data.schedulesFollowSiteTime
                    : undefined,
              });
            } else {
              siteDataMap.delete(siteId);
              console.warn(`Site "${siteId}" not found in Firestore`);
            }

            reported.add(siteId);
            updateStateFromMap();
          },
          (err) => {
            // Surfaced, not swallowed. A permission-denied here used to render as
            // "no sites", which is indistinguishable from genuinely having none —
            // so an access regression looked like an empty account. The other
            // sites keep their own listeners; this reports the one that failed.
            console.error(`Error fetching site ${siteId}:`, err);
            setError(`site ${siteId}: ${err.message}`);
            // A failed listener has answered too — without this one bad site
            // would hold the whole list at loading forever.
            reported.add(siteId);
            updateStateFromMap();
          }
        );
        unsubscribes.push(unsubscribe);
      });

      return () => {
        unsubscribes.forEach(unsub => unsub());
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error in useSites:', err);
      setError(message);
      setLoading(false);
    }
  }, [userId, userSites, isSuperadmin]);

  const createSite = async (
    siteId: string,
    name: string,
    _userId: string,
    timezone?: string,
    schedulesFollowSiteTime?: boolean,
  ): Promise<string> => {
    if (!db) throw new Error('Firebase not configured');

    const { isValid, error } = await import('@/lib/validators').then(m => m.validateSiteId(siteId));
    if (!isValid) {
      throw new Error(error);
    }

    // No pre-read existence check: non-owners get permission-denied on getDoc.
    // Rules block overwrites (setDoc on an existing doc hits the 'update' rule);
    // availability is checked in CreateSiteDialog.
    try {
      await apiJson('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId,
          name,
          timezone: timezone || 'UTC',
          // Omitted, never `false`, when the caller states nothing. The field is
          // three-state and an absent flag means "never asked" — sending `false`
          // would spend that state at creation and permanently suppress the
          // opt-in banner for a site nobody ever asked.
          ...(schedulesFollowSiteTime !== undefined ? { schedulesFollowSiteTime } : {}),
        }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('already exists')) {
        throw new Error(`Site ID "${siteId}" is already taken. Please choose a different ID.`);
      }
      throw err;
    }

    return siteId;
  };

  const updateSite = async (siteId: string, updates: { name?: string; timezone?: string; timeFormat?: '12h' | '24h'; schedulesFollowSiteTime?: boolean }) => {
    if (!db) throw new Error('Firebase not configured');
    if (updates.name !== undefined && !updates.name.trim()) {
      throw new Error('Site name cannot be empty');
    }

    const updateData: Record<string, string | boolean> = {};
    if (updates.name) updateData.name = updates.name.trim();
    if (updates.timezone) updateData.timezone = updates.timezone;
    if (updates.timeFormat) updateData.timeFormat = updates.timeFormat;
    // `!== undefined`, not truthiness: `false` is the escape hatch ("keep machine
    // clocks") and a truthiness check would silently drop it, leaving the site in
    // its unanswered state and re-prompting forever.
    if (updates.schedulesFollowSiteTime !== undefined) {
      updateData.schedulesFollowSiteTime = updates.schedulesFollowSiteTime;
    }

    if (Object.keys(updateData).length === 0) return;

    await apiJson(`/api/sites/${encodeURIComponent(siteId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData),
    });
  };

  const deleteSite = async (siteId: string) => {
    if (!db) throw new Error('Firebase not configured');

    // Firestore does not cascade-delete the machines subcollection.
    await apiJson(`/api/sites/${encodeURIComponent(siteId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    // TODO: arrayRemove this siteId from every user's `sites`. Until then admins
    // clean up orphans via the Manage Site Access dialog.
    logger.info(`Site ${siteId} deleted. Note: User references may need manual cleanup.`);
  };

  const checkSiteIdAvailability = async (siteId: string): Promise<boolean> => {
    if (!db) throw new Error('Firebase not configured');

    if (!siteId || siteId.trim() === '') {
      return false;
    }

    const { isValid } = await import('@/lib/validators').then(m => m.validateSiteId(siteId));
    if (!isValid) {
      return false;
    }

    // A live site OR a tombstone from a deleted one makes the id unavailable —
    // createSite refuses retired ids, so reporting them as free would send the
    // user through the form only to 409 on submit.
    const [siteSnap, tombstoneSnap] = await Promise.all([
      getDoc(doc(db, 'sites', siteId)),
      getDoc(doc(db, 'site_ids', siteId)),
    ]);

    return !siteSnap.exists() && !tombstoneSnap.exists();
  };

  return { sites, loading, error, createSite, updateSite, deleteSite, checkSiteIdAvailability };
}

// Module-level so consumers' memo/effect deps don't churn on a fresh [] each render.
const EMPTY_MACHINES: Machine[] = [];
const PROFILE_LISTENER_LIMIT = 50;

// Heartbeat age at which the pill flips offline. 300s tolerates two missed idle
// beats (120s each); 180s greyed out healthy machines on one slow tick. Must match
// OFFLINE_THRESHOLD_MS in `app/api/cron/health-check/route.ts` or pill and alerts disagree.
const OFFLINE_HEARTBEAT_AGE_SEC = 300;

/**
 * Single source of truth for "is this machine online": agent flag AND heartbeat
 * younger than OFFLINE_HEARTBEAT_AGE_SEC (Unix seconds; 0 = absent, fails the
 * check). Both the snapshot parser and the 30s staleness tick call this — with
 * separate logic a killed agent (doc stuck at `online: true`) rendered green
 * forever. Mirrors `classifyMachineHealth` in `app/api/cron/health-check/route.ts`.
 */
export function isMachineOnline(
  onlineFlag: unknown,
  lastHeartbeatSec: number,
  nowSec: number,
): boolean {
  if (onlineFlag !== true) return false;
  if (!Number.isFinite(lastHeartbeatSec)) return false;
  return nowSec - lastHeartbeatSec < OFFLINE_HEARTBEAT_AGE_SEC;
}

export function useMachineHardware(siteId: string | null, machineId: string | null) {
  const requestedKey = db && siteId && machineId ? `${siteId}/${machineId}` : null;
  const [state, setState] = useState<{
    key: string | null;
    profile: HardwareProfile | null;
    error: string | null;
  }>({ key: null, profile: null, error: null });

  useEffect(() => {
    if (!db || !siteId || !machineId || !requestedKey) return;

    const profileRef = doc(db, 'sites', siteId, 'machines', machineId, 'hardware', 'profile');
    const unsubscribe = onSnapshot(
      profileRef,
      (profileSnap) => {
        setState({
          key: requestedKey,
          profile: profileSnap.exists() ? profileSnap.data() as HardwareProfile : null,
          error: null,
        });
      },
      (e) => {
        console.debug(`Profile listener error for ${machineId}:`, e);
        setState({ key: requestedKey, profile: null, error: e.message });
      },
    );

    return () => unsubscribe();
  }, [siteId, machineId, requestedKey]);

  const hasFreshState = requestedKey !== null && state.key === requestedKey;
  return {
    profile: hasFreshState ? state.profile : null,
    loading: requestedKey !== null && !hasFreshState,
    error: !db ? 'Firebase not configured' : (hasFreshState ? state.error : null),
  };
}

export function useMachines(siteId: string) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [profiles, setProfiles] = useState<Record<string, HardwareProfile>>({});
  // Pins `machines` to the site it was populated for: a mismatch with `siteId`
  // yields empty + loading, so the effect never flips loading synchronously.
  const [loadedSiteId, setLoadedSiteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(db ? null : 'Firebase not configured');

  // Capped: one listener per machine hits Firebase's soft client listener ceiling
  // on large sites. Machines past the cap get metric-only `devices` below.
  const profileListenersRef = useRef<Record<string, Unsubscribe>>({});

  // Authoritative launch_mode/schedules from the config collection; without them
  // the stale status doc causes a ~10s flicker on load.
  const configOverridesRef = useRef<Record<string, Record<string, { launch_mode?: string; schedules?: ScheduleBlock[] | null; schedulePresetId?: string | null }>>>({});

  // In the config doc (not status) so the agent can cache it across Firestore
  // disconnects. `rebootSchedule` is the agent wire field — do not rename.
  const restartScheduleOverridesRef = useRef<Record<string, RestartSchedule | undefined>>({});

  // `displays.autoRestore.circuitBreaker.tripped` from the same config doc, so
  // list/card views need no per-row sub. Keyed by machineId; absent == false.
  const displayBreakerTrippedOverridesRef = useRef<Record<string, boolean>>({});

  // Config doc is source of truth; the status doc lags 10-120s. onSnapshot (not
  // getDocs) so agent-originated changes propagate.
  useEffect(() => {
    if (!db || !siteId) return;
    const configCol = collection(db, 'config', siteId, 'machines');
    const unsubConfig = onSnapshot(configCol, (snapshot) => {
      const overrides: typeof configOverridesRef.current = {};
      const restartOverrides: typeof restartScheduleOverridesRef.current = {};
      const breakerOverrides: typeof displayBreakerTrippedOverridesRef.current = {};
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.processes && Array.isArray(data.processes)) {
          const processMap: Record<string, { launch_mode?: string; schedules?: ScheduleBlock[] | null; schedulePresetId?: string | null }> = {};
          for (const proc of data.processes) {
            if (proc.id) {
              processMap[proc.id] = {
                launch_mode: proc.launch_mode,
                schedules: proc.schedules,
                schedulePresetId: proc.schedulePresetId ?? null,
              };
            }
          }
          overrides[docSnap.id] = processMap;
        }
        // `rebootSchedule` is the agent-written wire field — keep the key.
        if (data.rebootSchedule) {
          restartOverrides[docSnap.id] = data.rebootSchedule as RestartSchedule;
        }
        // Only record `true` to hold the absent-entry == false invariant.
        if (data.displays?.autoRestore?.circuitBreaker?.tripped === true) {
          breakerOverrides[docSnap.id] = true;
        }
      });
      configOverridesRef.current = overrides;
      restartScheduleOverridesRef.current = restartOverrides;
      displayBreakerTrippedOverridesRef.current = breakerOverrides;

      // apply to already-loaded machines
      setMachines(prev => prev.map(machine => {
        const machineOverrides = overrides[machine.machineId];
        const restartSchedule = restartOverrides[machine.machineId];
        const displayBreakerTripped = breakerOverrides[machine.machineId] === true;
        const next: Machine = { ...machine, rebootSchedule: restartSchedule, displayBreakerTripped };
        if (machineOverrides && next.processes) {
          next.processes = next.processes.map(p => {
            const override = machineOverrides[p.id];
            if (!override) return p;
            return {
              ...p,
              launch_mode: (override.launch_mode || p.launch_mode) as LaunchMode,
              schedules: override.schedules ?? p.schedules,
              schedulePresetId: override.schedulePresetId,
            };
          });
        }
        return next;
      }));
    }, (e) => {
      // non-critical: status doc values still work, just lag
      console.debug('Config override listener error:', e);
    });
    return () => unsubConfig();
  }, [siteId]);

  // 30s staleness sweep for machines that died without writing online=false
  // (crashes, installer kills). Must keep using `isMachineOnline` — the pill
  // flapped back when this had its own local guards.
  useEffect(() => {
    if (machines.length === 0) return;

    const interval = setInterval(() => {
      setMachines(prevMachines => {
        const now = Math.floor(Date.now() / 1000);
        let hasChanges = false;

        const updated = prevMachines.map(machine => {
          // Against the *derived* flag: only a fresh snapshot can bring a machine
          // back online, never this tick.
          const shouldBeOnline = isMachineOnline(machine.online, machine.lastHeartbeat, now);

          if (machine.online !== shouldBeOnline) {
            hasChanges = true;
            return { ...machine, online: shouldBeOnline };
          }
          return machine;
        });

        return hasChanges ? updated : prevMachines;
      });
    }, 30000);

    return () => clearInterval(interval);
  }, [machines.length]);

  useEffect(() => {
    if (!db || !siteId) return;

    // No sync state reset: loading derives from `loadedSiteId !== siteId` below.
    // No try/catch: collection() only throws on invalid paths (guarded above) and
    // onSnapshot reports runtime errors via its own callback.
    const machinesRef = collection(db, 'sites', siteId, 'machines');

    const unsubscribe = onSnapshot(
      machinesRef,
      (snapshot) => {
        // The heartbeat-age check applies to cache-served snapshots too: exempting
        // them and trusting `data.online` painted green pills on minutes-stale
        // machines until the 30s tick corrected them.

        // Reconcile the capped profile listeners; the first N IDs are deterministic
        // because the collection is sorted by machineId. Detail views use
        // useMachineHardware for an uncapped single-machine listener.
        const currentMachineIds = new Set<string>();
        snapshot.forEach((d) => currentMachineIds.add(d.id));
        const profiledMachineIds = Array.from(currentMachineIds)
          .sort((a, b) => a.localeCompare(b))
          .slice(0, PROFILE_LISTENER_LIMIT);
        const profiledMachineIdSet = new Set(profiledMachineIds);

        // Tear down listeners for machines no longer selected by the cap.
        for (const machineId of Object.keys(profileListenersRef.current)) {
          if (profiledMachineIdSet.has(machineId)) continue;
          profileListenersRef.current[machineId]();
          delete profileListenersRef.current[machineId];
          setProfiles((prev) => {
            if (!(machineId in prev)) return prev;
            const next = { ...prev };
            delete next[machineId];
            return next;
          });
        }

        // Open listeners for newly selected machines.
        for (const machineId of profiledMachineIds) {
          if (profileListenersRef.current[machineId]) continue;
          const profileRef = doc(db!, 'sites', siteId, 'machines', machineId, 'hardware', 'profile');
          profileListenersRef.current[machineId] = onSnapshot(
            profileRef,
            (profileSnap) => {
              if (!profileSnap.exists()) {
                setProfiles((prev) => {
                  if (!(machineId in prev)) return prev;
                  const next = { ...prev };
                  delete next[machineId];
                  return next;
                });
                return;
              }
              const profileData = profileSnap.data() as HardwareProfile;
              setProfiles((prev) => ({ ...prev, [machineId]: profileData }));
            },
            (e) => {
              // non-critical: profile is supplementary; metrics still render
              console.debug(`Profile listener error for ${machineId}:`, e);
            },
          );
        }

        setMachines(prevMachines => {
          const machineData: Machine[] = [];

          snapshot.forEach((doc) => {
            const data = doc.data();

            const prevMachine = prevMachines.find(m => m.machineId === doc.id);

          // processes live under metrics in newer agents, top-level in older ones
          let processes: Process[] = [];
          const processesData = data.metrics?.processes || data.processes;

          // Previous process state: keeps optimistic updates and avoids flicker when a
          // metrics upload momentarily lacks launch_mode mid-write.
          const prevProcessMap: Record<string, {
            launch_mode?: LaunchMode;
            schedules?: ScheduleBlock[] | null;
            _optimisticLaunchMode?: LaunchMode;
            _optimisticAutolaunch?: boolean;
            _optimisticSchedules?: ScheduleBlock[] | null;
            _optimisticPresetId?: string | null;
          }> = {};
          if (prevMachine?.processes) {
            for (const p of prevMachine.processes) {
              prevProcessMap[p.id] = {
                launch_mode: p.launch_mode,
                schedules: p.schedules,
                _optimisticLaunchMode: p._optimisticLaunchMode,
                _optimisticAutolaunch: p._optimisticAutolaunch,
                _optimisticSchedules: p._optimisticSchedules,
                _optimisticPresetId: p._optimisticPresetId,
              };
            }
          }

          if (processesData && typeof processesData === 'object') {
            processes = (Object.entries(processesData) as Array<[string, Partial<Process>]>)
              .map(([id, processData]) => {
                const prev = prevProcessMap[id];
                // config doc wins over the status doc for launch_mode/schedules
                const configOverride = configOverridesRef.current[doc.id]?.[id];
                const firestoreMode: LaunchMode = (configOverride?.launch_mode as LaunchMode) || processData.launch_mode || prev?.launch_mode || (processData.autolaunch ? 'always' : 'off');
                const firestoreSchedules = configOverride?.schedules ?? processData.schedules ?? prev?.schedules ?? null;
                const firestorePresetId = configOverride?.schedulePresetId ?? processData.schedulePresetId ?? null;

                // hold optimistic state until Firestore agrees with it
                const optimisticMode = prev?._optimisticLaunchMode;
                const keepOptimistic = optimisticMode !== undefined && optimisticMode !== firestoreMode;

                return {
                  id,
                  name: processData.name || 'Unknown',
                  status: processData.status || 'UNKNOWN',
                  pid: processData.pid || null,
                  autolaunch: processData.autolaunch || false,
                  launch_mode: firestoreMode,
                  schedulePresetId: firestorePresetId,
                  schedules: firestoreSchedules,
                  exe_path: processData.exe_path || '',
                  file_path: processData.file_path || '',
                  cwd: processData.cwd || '',
                  priority: processData.priority || 'Normal',
                  visibility: processData.visibility || 'Show',
                  time_delay: processData.time_delay || '0',
                  time_to_init: processData.time_to_init || '10',
                  relaunch_attempts: processData.relaunch_attempts || '3',
                  responsive: processData.responsive ?? true,
                  last_updated: processData.last_updated || 0,
                  index: processData.index ?? 999,
                  ...(keepOptimistic ? {
                    _optimisticLaunchMode: prev._optimisticLaunchMode,
                    _optimisticAutolaunch: prev._optimisticAutolaunch,
                    _optimisticSchedules: prev._optimisticSchedules,
                    _optimisticPresetId: prev._optimisticPresetId,
                  } : {}),
                };
              })
              .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
          }

          const lastHeartbeat = parseFirestoreSeconds(data.lastHeartbeat);

          // `rebootScheduledAt` is the agent-written wire field — keep the key.
          const restartScheduledAtParsed = parseFirestoreSeconds(data.rebootScheduledAt);
          const restartScheduledAt = restartScheduledAtParsed > 0 ? restartScheduledAtParsed : undefined;
          const shutdownScheduledAtParsed = parseFirestoreSeconds(data.shutdownScheduledAt);
          const shutdownScheduledAt = shutdownScheduledAtParsed > 0 ? shutdownScheduledAtParsed : undefined;

          const now = Math.floor(Date.now() / 1000);
          const isOnline = isMachineOnline(data.online, lastHeartbeat, now);

            // keep the last good GPU when this update reports "N/A"/missing
            const metrics = data.metrics ? {
              ...data.metrics,
              gpu: (data.metrics.gpu?.name && data.metrics.gpu.name !== 'N/A')
                ? data.metrics.gpu
                : prevMachine?.metrics?.gpu
            } : prevMachine?.metrics;

            machineData.push({
              machineId: doc.id,
              lastHeartbeat,
              online: isOnline,
              agent_version: data.agent_version,
              machineTimezone: typeof data.machine_timezone_iana === 'string' ? data.machine_timezone_iana : undefined,
              // only an explicit false disables hoot — absent means enabled, matching
              // the server's `isHootEnabled` (hoot-utils.server.ts)
              cortexEnabled: data.cortexEnabled !== false,
              capabilities: data.capabilities,
              rebooting: data.rebooting,
              shuttingDown: data.shuttingDown,
              rebootScheduledAt: restartScheduledAt,
              shutdownScheduledAt,
              rebootSchedule: restartScheduleOverridesRef.current[doc.id],
              displayBreakerTripped: displayBreakerTrippedOverridesRef.current[doc.id] === true,
              rebootState: data.rebootState,
              // agent-published "needs restart" banner payload, passed through verbatim
              rebootPending: data.rebootPending,
              metrics,
              processes,
            });
          });

          // stable ordering prevents row flicker
          machineData.sort((a, b) => a.machineId.localeCompare(b.machineId));

          return machineData;
        });
        setLoadedSiteId(siteId);
      },
      (err) => {
        console.error('Error fetching machines:', err);
        setError(err.message);
      }
    );

    return () => {
      unsubscribe();
      // next effect run reconciles the cap again
      for (const machineId of Object.keys(profileListenersRef.current)) {
        profileListenersRef.current[machineId]();
      }
      profileListenersRef.current = {};
      setProfiles({});
    };
  }, [siteId]);

  const killProcess = async (machineId: string, processId: string, processName: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    logger.debug(`Sending kill command for process "${processName}"`, {
      context: 'killProcess',
      data: { machineId, processId },
    });

    try {
      const result = await sendMachineCommand(machineId, 'kill_process', {
        process_name: processName,
        process_id: processId,
      });

      logger.firestore.write(`api/sites/${siteId}/machines/${machineId}/commands`, result, 'create');
      logger.debug('Kill command sent successfully', { context: 'killProcess' });
    } catch (error) {
      logger.firestore.error('Failed to send kill command', error);
      throw error;
    }
  };

  const setLaunchMode = async (
    machineId: string, processId: string, processName: string,
    mode: LaunchMode, schedules?: ScheduleBlock[] | null, schedulePresetId?: string | null
  ) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    // optimistic; cleared once the Firestore listener confirms
    setMachines(prevMachines =>
      prevMachines.map(machine => {
        if (machine.machineId === machineId) {
          return {
            ...machine,
            processes: machine.processes?.map(process => {
              if (process.id === processId) {
                return {
                  ...process,
                  _optimisticLaunchMode: mode,
                  _optimisticAutolaunch: mode !== 'off',
                  _optimisticSchedules: schedules ?? process.schedules,
                  _optimisticPresetId: schedulePresetId,
                };
              }
              return process;
            })
          };
        }
        return machine;
      })
    );

    // so subsequent listener fires use the new value
    if (!configOverridesRef.current[machineId]) configOverridesRef.current[machineId] = {};
    configOverridesRef.current[machineId][processId] = {
      launch_mode: mode,
      schedules: schedules ?? undefined,
      schedulePresetId: schedulePresetId,
    };

    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Setting launch mode for "${processName}" to ${mode}`, {
      context: 'setLaunchMode',
      data: { machineId, processId, mode },
    });

    try {
      // Firestore rejects undefined
      const cleanSchedules = schedules?.map(b => {
        const clean: Record<string, unknown> = { days: b.days, ranges: b.ranges };
        if (b.name) clean.name = b.name;
        if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
        return clean;
      });

      await apiJson(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/processes/${encodeURIComponent(processId)}/launch-mode`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey(`process-launch-mode-${siteId}-${machineId}-${processId}`),
          },
          body: JSON.stringify({
            mode,
            ...(cleanSchedules !== undefined ? { schedules: cleanSchedules } : {}),
            ...(schedulePresetId !== undefined ? { schedulePresetId: schedulePresetId || null } : {}),
          }),
        },
      );
      logger.firestore.write(configPath, undefined, 'update');

      logger.debug('Launch mode set via config system', { context: 'setLaunchMode' });
    } catch (error) {
      // roll back the optimistic update
      setMachines(prevMachines =>
        prevMachines.map(machine => {
          if (machine.machineId === machineId) {
            return {
              ...machine,
              processes: machine.processes?.map(process => {
                if (process.id === processId) {
                  const { _optimisticLaunchMode, _optimisticAutolaunch, _optimisticSchedules, _optimisticPresetId, ...rest } = process;
                  return rest;
                }
                return process;
              })
            };
          }
          return machine;
        })
      );
      // else the listener re-applies stale optimistic values
      if (configOverridesRef.current[machineId]) {
        delete configOverridesRef.current[machineId][processId];
      }
      // 401/403 = expected authz outcome (e.g. no MACHINE_CONFIG_WRITE); rethrow but keep out of Sentry
      if (isExpectedAuthzError(error)) {
        logger.debug('Launch mode denied (authorization)', {
          context: 'setLaunchMode',
          data: { machineId, processId, status: (error as ApiRequestError).status },
        });
      } else {
        logger.firestore.error('Failed to set launch mode', error);
      }
      throw error;
    }
  };

  const updateProcess = async (machineId: string, processId: string, updatedData: Partial<Process>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Updating process "${processId}"`, {
      context: 'updateProcess',
      data: { machineId, processId, updatedData },
    });

    try {
      // Firestore rejects undefined
      const cleanedData = { ...updatedData };
      if (cleanedData.schedules) {
        cleanedData.schedules = cleanedData.schedules.map(b => {
          const clean: ScheduleBlock = { days: b.days, ranges: b.ranges };
          if (b.name) clean.name = b.name;
          if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
          return clean;
        });
      }

      const patchData = { ...cleanedData } as Record<string, unknown>;
      for (const key of [
        'id',
        'processId',
        'status',
        'pid',
        'responsive',
        'last_updated',
        'index',
        '_optimisticAutolaunch',
        '_optimisticLaunchMode',
        '_optimisticSchedules',
        '_optimisticPresetId',
      ]) {
        delete patchData[key];
      }

      if (Object.keys(patchData).length === 0) {
        logger.debug('No persisted process fields to update', { context: 'updateProcess' });
        return;
      }

      await apiJson(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/processes/${encodeURIComponent(processId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patchData),
        },
      );

      logger.firestore.write(configPath, undefined, 'update');
      logger.debug('Process updated successfully', { context: 'updateProcess' });
    } catch (error: unknown) {
      logger.firestore.error('Failed to update process', error);

      const e = error as { code?: string; message?: string };

      console.error('[Firestore Error] updateProcess failed:', {
        error,
        code: e?.code,
        message: e?.message,
        siteId,
        machineId,
        processId
      });

      if (e?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to update process configuration. Please check Firestore security rules.');
      } else if (e?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (e?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const deleteProcess = async (machineId: string, processId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug(`Deleting process "${processId}"`, {
      context: 'deleteProcess',
      data: { machineId, processId },
    });

    try {
      await apiJson(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/processes/${encodeURIComponent(processId)}`,
        { method: 'DELETE' },
      );

      logger.firestore.write(configPath, undefined, 'delete');
      logger.debug('Process deleted successfully', { context: 'deleteProcess' });
    } catch (error: unknown) {
      logger.firestore.error('Failed to delete process', error);

      const e = error as { code?: string; message?: string };

      console.error('[Firestore Error] deleteProcess failed:', {
        error,
        code: e?.code,
        message: e?.message,
        siteId,
        machineId,
        processId
      });

      if (e?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to delete process configuration. Please check Firestore security rules.');
      } else if (e?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (e?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const createProcess = async (machineId: string, processData: Partial<Process>) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const configPath = `config/${siteId}/machines/${machineId}`;

    logger.debug('Creating new process', {
      context: 'createProcess',
      data: { machineId, processData },
    });

    try {
      const schedules = processData.schedules?.map(b => {
        const clean: ScheduleBlock = { days: b.days, ranges: b.ranges };
        if (b.name) clean.name = b.name;
        if (b.colorIndex != null) clean.colorIndex = b.colorIndex;
        return clean;
      }) ?? null;

      const payload = {
        name: processData.name || 'Untitled Process',
        exe_path: processData.exe_path || '',
        file_path: processData.file_path || '',
        cwd: processData.cwd || '',
        priority: processData.priority || 'Normal',
        visibility: processData.visibility || 'Show',
        time_delay: processData.time_delay || '0',
        time_to_init: processData.time_to_init || '10',
        relaunch_attempts: processData.relaunch_attempts || '3',
        launch_mode: processData.launch_mode || 'off',
        schedules,
      };

      const response = await apiJson<{ ok: true; data: { processId: string } }>(
        `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/processes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': makeIdempotencyKey(`process-create-${siteId}-${machineId}`),
          },
          body: JSON.stringify(payload),
        },
      );
      const newProcessId = response.data.processId;

      logger.firestore.write(configPath, undefined, 'create');
      logger.debug('Process created successfully', { context: 'createProcess', data: { newProcessId } });

      return newProcessId;
    } catch (error: unknown) {
      logger.firestore.error('Failed to create process', error);

      const e = error as { code?: string; message?: string };

      console.error('[Firestore Error] createProcess failed:', {
        error,
        code: e?.code,
        message: e?.message,
        siteId,
        machineId,
        processData
      });

      if (e?.code === 'permission-denied') {
        throw new Error('Permission denied: Unable to create process configuration. Please check Firestore security rules.');
      } else if (e?.code === 'not-found') {
        throw new Error('Machine or config document not found. The machine may have been removed.');
      } else if (e?.code === 'unavailable') {
        throw new Error('Firestore is temporarily unavailable. Please try again in a moment.');
      }

      throw error;
    }
  };

  const sendMachineCommand = async (machineId: string, commandType: string, extraData: Record<string, unknown> = {}) => {
    if (!db || !siteId) throw new Error('Firebase not configured');

    const response = await apiJson<{ ok: true; data: { commandId: string } }>(
      `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/commands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': makeIdempotencyKey(`machine-command-${commandType}-${machineId}`),
        },
        body: JSON.stringify({
          type: commandType,
          params: extraData,
        }),
      },
    );

    return response.data.commandId;
  };

  const restartMachine = async (machineId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    // optimistic countdown while the API queues the command
    const targetRestart = Math.floor(Date.now() / 1000) + 30;
    // 'reboot_machine' is the agent's wire verb — keep it.
    await sendMachineCommand(machineId, 'reboot_machine', { delay_seconds: 30 });
    setMachines(prevMachines =>
      prevMachines.map(machine =>
        machine.machineId === machineId ? {
          ...machine,
          rebootScheduledAt: targetRestart,
        } : machine
      )
    );
  };

  const shutdownMachine = async (machineId: string) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    // optimistic countdown while the API queues the command
    const targetShutdown = Math.floor(Date.now() / 1000) + 30;
    await sendMachineCommand(machineId, 'shutdown_machine', { delay_seconds: 30 });
    setMachines(prevMachines =>
      prevMachines.map(machine =>
        machine.machineId === machineId ? {
          ...machine,
          shutdownScheduledAt: targetShutdown,
        } : machine
      )
    );
  };

  const cancelRestart = async (machineId: string) => {
    // 'cancel_reboot' is the agent's wire verb — keep it.
    await sendMachineCommand(machineId, 'cancel_reboot');
  };

  const dismissRestartPending = async (machineId: string, processName: string) => {
    // 'dismiss_reboot_pending' is the agent's wire verb — keep it.
    await sendMachineCommand(machineId, 'dismiss_reboot_pending', { process_name: processName });
  };

  const captureScreenshot = async (machineId: string) => {
    await sendMachineCommand(machineId, 'capture_screenshot');
  };

  const startLiveView = async (machineId: string, interval: number = 10, duration: number = 600) => {
    await sendMachineCommand(machineId, 'start_live_view', { interval, duration });
  };

  const stopLiveView = async (machineId: string) => {
    await sendMachineCommand(machineId, 'stop_live_view');
  };

  /**
   * Merges into `config/{siteId}/machines/{machineId}.rebootSchedule` — the field
   * and endpoint keep the legacy "reboot" spelling because deployed agents read
   * them. The agent mirrors it into local config.json, so schedules still fire
   * across Firestore disconnects. No `configChangeFlag`: config-doc rules allow
   * direct writes from anyone with site access (status-doc writes do not).
   */
  const updateRestartSchedule = async (machineId: string, schedule: RestartSchedule) => {
    if (!db || !siteId) throw new Error('Firebase not configured');
    await apiJson(
      `/api/sites/${encodeURIComponent(siteId)}/machines/${encodeURIComponent(machineId)}/reboot-schedule`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule }),
      },
    );
  };

  // Shim legacy machines to v2, then derive `devices`. Memoized on the raw
  // inputs so unrelated re-renders don't re-derive.
  const joinedMachines = useMemo(() => {
    return machines.map((m) => {
      const profile = profiles[m.machineId];
      const withProfile = profile ? { ...m, profile } : m;
      const shimmed = shimLegacyMachine(withProfile);
      return joinMachineDevices(shimmed);
    });
  }, [machines, profiles]);

  const machinesForCurrentSite = loadedSiteId === siteId ? joinedMachines : EMPTY_MACHINES;
  const loading = !!db && !!siteId && loadedSiteId !== siteId;

  return { machines: machinesForCurrentSite, loading, error, killProcess, setLaunchMode, updateProcess, deleteProcess, createProcess, restartMachine, shutdownMachine, cancelRestart, dismissRestartPending, captureScreenshot, startLiveView, stopLiveView, updateRestartSchedule };
}
