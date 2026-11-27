/**
 * Deterministic Firestore seed data for the marketing screenshot pipeline.
 *
 * Byte-identical PNGs require: emulator reset per scenario, re-seeded baseline
 * users/sites (role storageState depends on them), hard-coded ids, every
 * timestamp anchored to FIXED_NOW_MS, and all "random" series from a seeded
 * mulberry32 PRNG.
 *
 *   const ctx = await seedScreenshotFixtures('dashboard-mixed-states');
 *   await page.goto(`/dashboard?site=${ctx.siteId}`);
 *   await ctx.cleanup();
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../helpers/emulator';
import {
  seedMachine,
  seedRoostWithVersionHistory,
  TEST_USERS,
  type SeedMachineOptions,
} from '../helpers/seed';
import type { TalonDoc } from '@/lib/talons/types';

export type ScreenshotScenario =
  | 'dashboard-mixed-states'
  | 'pairing-first-machine'
  | 'monitor-single-machine'
  | 'control-process-restarting'
  | 'deploy-roost-rolling'
  | 'diagnose-cortex-chat'
  | 'display-layout-editor'
  | 'automate-schedule-editor'
  | 'automate-talons-list'
  | 'display-storyboard-frame-1'
  | 'display-storyboard-frame-2'
  | 'display-storyboard-frame-3';

export interface ScreenshotFixture {
  siteId: string;
  machineId?: string;
  processId?: string;
  cleanup: () => Promise<void>;
}

/**
 * Seed the emulator for `scenario`; returns the canonical ids plus a cleanup fn
 * for test.afterEach. Idempotent — reset + fixed ids/timestamps/PRNG seed.
 */
export async function seedScreenshotFixtures(
  scenario: ScreenshotScenario,
): Promise<ScreenshotFixture> {
  await resetAndReseedBaseline();

  switch (scenario) {
    case 'dashboard-mixed-states':
      return seedDashboardMixedStates();
    case 'pairing-first-machine':
      return seedPairingFirstMachine();
    case 'monitor-single-machine':
      return seedMonitorSingleMachine();
    case 'control-process-restarting':
      return seedControlProcessRestarting();
    case 'deploy-roost-rolling':
      return seedDeployRoostRolling();
    case 'diagnose-cortex-chat':
      return seedDiagnoseHootChat();
    case 'display-layout-editor':
      return seedDisplayLayoutEditor();
    case 'automate-schedule-editor':
      return seedAutomateScheduleEditor();
    case 'automate-talons-list':
      return seedAutomateTalonsList();
    case 'display-storyboard-frame-1':
      return seedDisplayStoryboardFrame(1);
    case 'display-storyboard-frame-2':
      return seedDisplayStoryboardFrame(2);
    case 'display-storyboard-frame-3':
      return seedDisplayStoryboardFrame(3);
    default: {
      // Compile-time exhaustiveness check.
      const _exhaustive: never = scenario;
      throw new Error(`unknown screenshot scenario: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Anchor for every relative timestamp. Outside DST transitions in common
 * timezones so "x hours ago" text is stable. 2026-04-15 14:30:00 UTC.
 */
export const FIXED_NOW_MS = Date.UTC(2026, 3, 15, 14, 30, 0);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

/** Convert a relative offset (seconds before FIXED_NOW) to a Timestamp. */
function tsAgo(secondsAgo: number): Timestamp {
  return Timestamp.fromMillis(FIXED_NOW_MS - secondsAgo * 1000);
}

/** Seeded mulberry32 PRNG: same seed → same sequence, so series are stable. */
function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic site cleanup. Not clearFirestoreEmulator — specs may share the
 * emulator lifetime with other tests in the same run.
 */
async function deleteSiteSubtree(siteId: string): Promise<void> {
  const db = getAdminDb();
  const siteRef = db.collection('sites').doc(siteId);
  const configRef = db.collection('config').doc(siteId);

  const subcollectionNames = [
    'machines',
    'roosts',
    'deployments',
    'installer_templates',
    'logs',
    // Talon definitions and their run history — both live directly under the
    // site, so a scenario that seeds either would otherwise leak into the next.
    'talons',
    'talon_runs',
  ];

  for (const sub of subcollectionNames) {
    const snap = await siteRef.collection(sub).listDocuments();
    for (const ref of snap) {
      // Machines nest hardware/, screenshots/, etc. — recurse manually.
      await deleteRecursive(ref);
    }
  }

  // Schedule + reboot presets live under config/{siteId}/...
  const configSubs = ['schedule_presets', 'reboot_presets', 'machines'];
  for (const sub of configSubs) {
    const snap = await configRef.collection(sub).listDocuments();
    for (const ref of snap) {
      await deleteRecursive(ref);
    }
  }

  await siteRef.delete().catch(() => undefined);
  await configRef.delete().catch(() => undefined);
}

async function deleteRecursive(
  ref: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const subcollections = await ref.listCollections();
  for (const c of subcollections) {
    const docs = await c.listDocuments();
    for (const d of docs) {
      await deleteRecursive(d);
    }
  }
  await ref.delete().catch(() => undefined);
}

/**
 * Drops only site-A's data; firestore + auth users persist from global-setup.
 * Do NOT call seedBaseline here — its seedUser path does auth.updateUser({
 * password }), which invalidates refresh tokens and breaks the storageState
 * session cookies captured during global-setup.
 */
async function resetAndReseedBaseline(): Promise<void> {
  await deleteSiteSubtree('site-A');
  // Restore the bare site-A doc; merge so the per-scenario seed layers on top.
  const db = getAdminDb();
  await db.collection('sites').doc('site-A').set({
    name: 'Site A (Assigned)',
    owner: 'someone-else',
    timezone: 'UTC',
  }, { merge: true });
}

/**
 * Layer per-scenario name/tier onto the canonical `site-A` rather than a fresh
 * site: the dashboard auto-selects it. Forcing a site selection from the spec
 * races the firestore writes against the dashboard's site-pick effect.
 */
async function seedScreenshotSite(
  siteId: string,
  name: string,
  ownerUid: string = TEST_USERS.admin.uid,
): Promise<void> {
  const db = getAdminDb();
  // Merge — preserve baseline fields (owner, etc).
  await db.collection('sites').doc(siteId).set(
    {
      name,
      tier: 'pro',
      timezone: 'America/Los_Angeles',
      createdAt: tsAgo(60 * 60 * 24 * 30),
    },
    { merge: true },
  );
  // Idempotent: admin already has site-A in their sites[] from baseline.
  await db.collection('users').doc(ownerUid).set(
    { sites: FieldValue.arrayUnion(siteId) },
    { merge: true },
  );
}

export interface MetricsSample {
  cpuPct: number;
  memPct: number;
  memUsedGb: number;
  gpuPct: number;
  diskPct: number;
  /**
   * Round-trip latency in ms. The card's COLLAPSED summary row is the only
   * place this renders: <=50 green, >50 amber, >100 red. Defaults to 12 (green).
   */
  latencyMs?: number;
  /**
   * Packet loss %. Also collapsed-row only, and the chip is HIDDEN at 0 — a
   * scene that needs it on camera must seed a non-zero value. Defaults to 0.
   */
  packetLossPct?: number;
}

/**
 * v2-shaped metrics doc; caller picks the sample so each card renders distinctly.
 *
 * Exported for `videos/03-install-and-pair.video.ts`, which fires the agent's
 * two startup writes a few seconds apart on camera (presence first, then the
 * first metrics upload — `agent/src/firebase_client.py:591-607`). That scene
 * hand-rolls the presence half and calls this for the metrics half, so the
 * newly-paired card fills in with exactly the shape every other fixture card
 * carries.
 */
export async function writeMachineMetrics(
  siteId: string,
  machineId: string,
  sample: MetricsSample,
  heartbeatOffsetSec = 0,
): Promise<void> {
  const db = getAdminDb();
  const heartbeat = FIXED_NOW_SEC - heartbeatOffsetSec;
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        // Mirrors OFFLINE_HEARTBEAT_AGE_SEC (300s) in lib/machineOnline.
        online: heartbeatOffsetSec < 300,
        lastHeartbeat: heartbeat,
        agent_version: '3.0.0',
        machine_timezone_iana: 'America/Los_Angeles',
        capabilities: { displayRemoteApply: 1 },
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(heartbeatOffsetSec),
          cpus: { CPU0: { percent: sample.cpuPct, temperature: 58 } },
          memory: { percent: sample.memPct, usedGb: sample.memUsedGb },
          disks: {
            'C:': { percent: sample.diskPct, usedGb: 320 },
            'D:': { percent: Math.max(5, sample.diskPct - 12), usedGb: 1450 },
          },
          gpus: {
            'NVIDIA RTX A5000': {
              name: 'NVIDIA RTX A5000',
              usagePercent: sample.gpuPct,
              vramUsedGb: 4.2,
              temperature: 62,
            },
          },
          nics: {
            'Ethernet 1': { txBps: 250_000, rxBps: 1_200_000, txUtil: 2, rxUtil: 12 },
            'Tailscale': { txBps: 80_000, rxBps: 95_000, txUtil: 0.5, rxUtil: 0.6 },
          },
          diskio: {
            'C:': { readBps: 3_000_000, writeBps: 4_000_000, busyPct: 8, maxBps: 500_000_000 },
            'D:': { readBps: 80_000_000, writeBps: 12_000_000, busyPct: 35, maxBps: 3_000_000_000 },
          },
          network: {
            latencyMs: sample.latencyMs ?? 12,
            packetLossPct: sample.packetLossPct ?? 0,
            gatewayIp: '192.168.1.1',
          },
          primary: { cpu: 'CPU0', disk: 'C:', gpu: 'NVIDIA RTX A5000', nic: 'Ethernet 1' },
        },
      },
      { merge: true },
    );

  // Hardware profile so useMachines can join devices end-to-end.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('hardware')
    .doc('profile')
    .set({
      schemaVersion: 1,
      signatureHash: `sig-${machineId}`,
      capturedAt: tsAgo(60 * 60 * 24),
      agentVersion: '3.0.0',
      cpus: [
        {
          id: 'CPU0',
          model: 'Intel Xeon W-2295',
          physicalCores: 18,
          logicalCores: 36,
          socketIndex: 0,
        },
      ],
      disks: [
        { id: 'C:', label: 'System', fs: 'NTFS', totalGb: 1000 },
        { id: 'D:', label: 'Media', fs: 'NTFS', totalGb: 4000 },
      ],
      gpus: [
        {
          id: 'NVIDIA RTX A5000',
          name: 'NVIDIA RTX A5000',
          vramTotalGb: 24,
          pciBus: '0000:01:00.0',
        },
      ],
      nics: [
        { id: 'Ethernet 1', mac: '00:1a:2b:3c:4d:5e', linkSpeedMbps: 1000 },
        { id: 'Tailscale', mac: '00:00:00:00:00:01', linkSpeedMbps: 100 },
      ],
    });
}

/** One managed process as the agent reports it. */
interface ProcEntry {
  id: string;
  name: string;
  status: 'RUNNING' | 'LAUNCHING' | 'STOPPED';
  pid: number;
  exe_path: string;
  file_path?: string;
  cwd: string;
  /** Seconds before FIXED_NOW that the agent last touched this row. */
  last_updated_offset: number;
  responsive?: boolean;
}

/**
 * Write a machine's managed processes to BOTH places the dashboard needs them.
 *
 * The card's process list renders from the agent-written status map
 * (`machines/{id}.metrics.processes`, useFirestore.ts:1012) and the dashboard's
 * "processes" stat tile counts exactly that map (page.tsx:804) — so a fixture
 * that writes only the config doc leaves both empty. The config doc
 * (`config/{siteId}/machines/{id}.processes`) is what the launch-mode and
 * schedule controls read back.
 */
async function writeMachineProcesses(
  siteId: string,
  machineId: string,
  processes: ProcEntry[],
): Promise<void> {
  const db = getAdminDb();

  const processMap: Record<string, unknown> = {};
  processes.forEach((p, idx) => {
    processMap[p.id] = {
      name: p.name,
      status: p.status,
      pid: p.pid,
      autolaunch: true,
      launch_mode: 'always',
      exe_path: p.exe_path,
      file_path: p.file_path ?? '',
      cwd: p.cwd,
      priority: 'Normal',
      visibility: 'Show',
      time_delay: '0',
      time_to_init: '5',
      relaunch_attempts: '3',
      responsive: p.responsive ?? true,
      last_updated: FIXED_NOW_SEC - p.last_updated_offset,
      index: idx,
    };
  });

  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set({ metrics: { processes: processMap } }, { merge: true });

  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        processes: processes.map((p) => ({
          id: p.id,
          name: p.name,
          launch_mode: 'always',
          schedules: null,
        })),
      },
      { merge: true },
    );
}

/**
 * Plausible fleet — 10 machines mixing running, alerting and offline;
 * CPU/mem hand-tuned so it reads as a real operations view.
 *
 * Counts every consumer depends on, and which must not drift: 10 machines, of
 * which exactly one (`touring-rig-04`) is offline. Eight machines carry managed
 * processes — twelve in total, so the dashboard's "processes" stat tile reads
 * 12; `lobby-display` (bare card for the docs stills) and offline
 * `touring-rig-04` deliberately carry none. Displays vary per venue role
 * (portrait kiosks, 4K signage, triple operator walls) — the uniform dual
 * "Test Monitor" fleet read as fake on camera.
 */
async function seedDashboardMixedStates(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  await seedScreenshotSite(siteId, 'flagship');

  type Spec = {
    machineId: string;
    state: 'running' | 'alerting' | 'offline';
    sample: MetricsSample;
    seedOpts?: SeedMachineOptions;
    /**
     * Managed processes as the agent reports them. Deliberately absent on
     * `lobby-display`, which `machine-card.spec.ts` and
     * `add-process-dialog.spec.ts` frame — those docs screenshots want the bare
     * card and the empty-state "add process" button.
     */
    processes?: ProcEntry[];
    /**
     * Per-device history overrides. Only `media-server-stage` carries them: the
     * MetricsDetailPanel discovers its disk / gpu / nic tabs from the samples'
     * `ds` / `gs` / `n` arrays, and ep07 b06 films that variety on the same
     * fleet that trips the >5-machine title-bar switcher.
     */
    history?: {
      disks?: HistoryDiskSpec[];
      gpus?: HistoryGpuSpec[];
      nics?: HistoryNicSpec[];
    };
  };

  // 10 machines: 5 running, 4 alerting, 1 offline.
  const specs: Spec[] = [
    { machineId: 'lobby-display', state: 'running',
      sample: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 },
      seedOpts: { monitors: [
        { widthPx: 3840, heightPx: 2160, friendlyName: 'LG UH5F-H 86' },
      ] } },
    {
      machineId: 'museum-kiosk-1',
      state: 'running',
      sample: { cpuPct: 31, memPct: 44, memUsedGb: 14.0, gpuPct: 26, diskPct: 52 },
      seedOpts: { monitors: [
        { widthPx: 1920, heightPx: 1080, rotation: 90, friendlyName: 'ELO 2270L Touch' },
      ] },
      processes: [
        {
          id: 'proc-kiosk-shell-1',
          name: 'kiosk-shell.exe',
          status: 'RUNNING',
          pid: 2210,
          exe_path: 'C:\Owlette\kiosk\kiosk-shell.exe',
          cwd: 'C:\Owlette\kiosk',
          last_updated_offset: 22,
        },
      ],
    },
    {
      machineId: 'museum-kiosk-2',
      state: 'running',
      sample: { cpuPct: 27, memPct: 40, memUsedGb: 12.7, gpuPct: 21, diskPct: 49 },
      seedOpts: { monitors: [
        { widthPx: 1920, heightPx: 1080, rotation: 90, friendlyName: 'ELO 2270L Touch' },
      ] },
      processes: [
        {
          id: 'proc-kiosk-shell-2',
          name: 'kiosk-shell.exe',
          status: 'RUNNING',
          pid: 2214,
          exe_path: 'C:\Owlette\kiosk\kiosk-shell.exe',
          cwd: 'C:\Owlette\kiosk',
          last_updated_offset: 31,
        },
      ],
    },

    {
      machineId: 'media-server-stage',
      state: 'alerting',
      sample: { cpuPct: 86, memPct: 78, memUsedGb: 49.8, gpuPct: 71, diskPct: 88 },
      seedOpts: { monitors: [
        { widthPx: 3840, heightPx: 2160, friendlyName: 'Novastar MX40 A' },
        { widthPx: 3840, heightPx: 2160, friendlyName: 'Novastar MX40 B' },
        { widthPx: 1920, heightPx: 1080, friendlyName: 'Operator GUI' },
      ] },
      processes: [
        {
          id: 'proc-mediaserver-main',
          name: 'media-server.exe',
          status: 'RUNNING',
          pid: 7320,
          exe_path: 'C:\\Owlette\\bin\\media-server.exe',
          cwd: 'C:\\Owlette\\bin',
          last_updated_offset: 12,
        },
        {
          id: 'proc-td-playback',
          name: 'TouchDesigner.exe',
          status: 'RUNNING',
          pid: 4218,
          exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          file_path: 'C:\\Owlette\\projects\\stage-show\\main.toe',
          cwd: 'C:\\Owlette\\projects\\stage-show',
          last_updated_offset: 18,
        },
        {
          id: 'proc-watchtower',
          name: 'watchtower.exe',
          status: 'RUNNING',
          pid: 2884,
          exe_path: 'C:\\Owlette\\bin\\watchtower.exe',
          cwd: 'C:\\Owlette\\bin',
          last_updated_offset: 44,
        },
      ],
      // Mirrors monitor-single-machine's focus specs so both scenarios show the
      // same device set — 2 disks (each with a paired I/O tab), 2 nics, 1 gpu.
      history: {
        disks: [
          { id: 'C:', pctBase: 88, ioReadBpsBase: 3_000_000, ioWriteBpsBase: 4_000_000, maxBps: 500_000_000 },
          { id: 'D:', pctBase: 74, ioReadBpsBase: 80_000_000, ioWriteBpsBase: 12_000_000, maxBps: 3_000_000_000 },
        ],
        gpus: [{ id: 'NVIDIA RTX A5000', usageBase: 71, tempBase: 72 }],
        nics: [
          { id: 'Ethernet 1', txBpsBase: 250_000, rxBpsBase: 1_200_000, txUtilBase: 2, rxUtilBase: 12 },
          { id: 'Tailscale', txBpsBase: 80_000, rxBpsBase: 95_000, txUtilBase: 0.5, rxUtilBase: 0.6 },
        ],
      },
    },
    {
      machineId: 'nyc-signage-01',
      state: 'alerting',
      seedOpts: { monitors: [
        { widthPx: 3840, heightPx: 2160, friendlyName: 'Samsung QM85R' },
        { widthPx: 3840, heightPx: 2160, friendlyName: 'Samsung QM85R' },
      ] },
      // The network-degraded machine: >100ms reads red on the collapsed row's
      // ping chip, and the loss chip only renders above zero. ep07 b04 films it.
      sample: {
        cpuPct: 72, memPct: 81, memUsedGb: 25.9, gpuPct: 64, diskPct: 76,
        latencyMs: 128, packetLossPct: 2.4,
      },
      processes: [
        {
          id: 'proc-signage-player',
          name: 'BrightSignSigner.exe',
          status: 'RUNNING',
          pid: 1180,
          exe_path: 'C:\\Owlette\\signage\\BrightSignSigner.exe',
          cwd: 'C:\\Owlette\\signage',
          last_updated_offset: 8,
        },
      ],
    },
    {
      machineId: 'unreal-render-1',
      state: 'alerting',
      seedOpts: { monitors: [
        { widthPx: 2560, heightPx: 1440, friendlyName: 'Dell U2723QE' },
      ] },
      sample: { cpuPct: 91, memPct: 65, memUsedGb: 41.4, gpuPct: 94, diskPct: 58 },
      processes: [
        {
          id: 'proc-unreal-render',
          name: 'UnrealEditor.exe',
          status: 'RUNNING',
          pid: 6602,
          exe_path: 'C:\\Program Files\\Epic Games\\UE_5.4\\Engine\\Binaries\\Win64\\UnrealEditor.exe',
          file_path: 'C:\\Owlette\\projects\\tour\\Tour.uproject',
          cwd: 'C:\\Owlette\\projects\\tour',
          last_updated_offset: 21,
        },
        {
          id: 'proc-render-queue',
          name: 'render-queue.exe',
          status: 'RUNNING',
          pid: 6741,
          exe_path: 'C:\\Owlette\\bin\\render-queue.exe',
          cwd: 'C:\\Owlette\\bin',
          last_updated_offset: 90,
        },
      ],
    },
    {
      machineId: 'td-control-room',
      state: 'alerting',
      seedOpts: { monitors: [
        { widthPx: 2560, heightPx: 1440, friendlyName: 'Dell U2520D' },
        { widthPx: 2560, heightPx: 1440, friendlyName: 'Dell U2520D' },
        { widthPx: 2560, heightPx: 1440, friendlyName: 'Dell U2520D' },
      ] },
      sample: { cpuPct: 79, memPct: 70, memUsedGb: 22.4, gpuPct: 55, diskPct: 67 },
      processes: [
        {
          id: 'proc-td-control',
          name: 'TouchDesigner.exe',
          status: 'RUNNING',
          pid: 3390,
          exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          file_path: 'C:\\Owlette\\projects\\control\\control.toe',
          cwd: 'C:\\Owlette\\projects\\control',
          last_updated_offset: 15,
        },
        {
          id: 'proc-obs-stream',
          name: 'obs64.exe',
          status: 'RUNNING',
          pid: 5102,
          exe_path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
          cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit',
          last_updated_offset: 600,
        },
      ],
    },

    { machineId: 'touring-rig-04', state: 'offline',
      sample: { cpuPct: 0, memPct: 0, memUsedGb: 0, gpuPct: 0, diskPct: 0 } },

    {
      machineId: 'lobby-2',
      state: 'running',
      sample: { cpuPct: 12, memPct: 22, memUsedGb: 7.0, gpuPct: 8, diskPct: 33 },
      seedOpts: { monitors: [
        { widthPx: 3840, heightPx: 2160, friendlyName: 'Samsung QM50B' },
      ] },
      processes: [
        {
          id: 'proc-lobby-wall',
          name: 'TouchDesigner.exe',
          status: 'RUNNING',
          pid: 3812,
          exe_path: 'C:\Program Files\Derivative\TouchDesigner\bin\TouchDesigner.exe',
          file_path: 'C:\Owlette\projects\lobby\lobby-wall.toe',
          cwd: 'C:\Owlette\projects\lobby',
          last_updated_offset: 26,
        },
      ],
    },
    {
      machineId: 'mainstage-led',
      state: 'running',
      seedOpts: { monitors: [
        { widthPx: 1920, heightPx: 1080, friendlyName: 'LED Processor A' },
        { widthPx: 1920, heightPx: 1080, friendlyName: 'LED Processor B' },
      ] },
      sample: { cpuPct: 18, memPct: 29, memUsedGb: 9.2, gpuPct: 14, diskPct: 38 },
      processes: [
        {
          id: 'proc-resolume',
          name: 'avenue.exe',
          status: 'RUNNING',
          pid: 9024,
          exe_path: 'C:\\Program Files\\Resolume Avenue\\Avenue.exe',
          cwd: 'C:\\Program Files\\Resolume Avenue',
          last_updated_offset: 30,
        },
      ],
    },
  ];

  // Per-machine PRNG seed (stable: machineId → seed) so traces differ per row.
  const seedFor = (id: string): number =>
    id.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0xc0ffee00);

  for (const spec of specs) {
    const heartbeatOffset = spec.state === 'offline' ? 600 : 5;
    await seedMachine(siteId, spec.machineId, {
      ...spec.seedOpts,
      heartbeatOffsetSec: heartbeatOffset,
    });
    await writeMachineMetrics(siteId, spec.machineId, spec.sample, heartbeatOffset);

    if (spec.processes) {
      await writeMachineProcesses(siteId, spec.machineId, spec.processes);
    }

    // metrics_history so each row's inline sparkline renders; centered on the
    // machine's current sample so the trace flows into the present.
    if (spec.state !== 'offline') {
      await writeMetricsHistory(siteId, spec.machineId, {
        cpuBase: spec.sample.cpuPct,
        memBase: spec.sample.memPct,
        diskBase: spec.sample.diskPct,
        gpuBase: spec.sample.gpuPct,
        seed: seedFor(spec.machineId),
        ...spec.history,
      });
    }
  }

  return {
    siteId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * A real site with NO machines — what a first-time operator is looking at while
 * they pair. Episode 3's web take needs exactly this: the dashboard renders the
 * getting-started card, and the machine the scene writes mid-take is the only
 * card on screen when it lands (on `dashboard-mixed-states` the pop would be one
 * more tile in a ten-card grid, and the "pair your FIRST machine" narration
 * would be reading over a fleet that already exists).
 *
 * The site is named for the script's b07 dropdown pick; the desktop side calls
 * the same site `main gallery` too (`e2e/desktop-videos/fixtures.ts`).
 * `resetAndReseedBaseline` above has already emptied site-A, so seeding nothing
 * else is the whole scenario.
 */
async function seedPairingFirstMachine(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  await seedScreenshotSite(siteId, 'main gallery');

  return {
    siteId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * Focus on `media-server-stage` among 4 machines; deterministic
 * metrics_history buckets so every card's sparklines render.
 */
async function seedMonitorSingleMachine(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const focusMachineId = 'media-server-stage';
  await seedScreenshotSite(siteId, 'flagship');

  type MachineSpec = {
    id: string;
    metrics: { cpuPct: number; memPct: number; memUsedGb: number; gpuPct: number; diskPct: number };
    history: {
      cpuBase: number;
      memBase: number;
      diskBase: number;
      gpuBase: number;
      seed: number;
      disks?: HistoryDiskSpec[];
      gpus?: HistoryGpuSpec[];
      nics?: HistoryNicSpec[];
    };
  };

  // Two disks + two NICs + named GPU: drives the chart's per-device tab
  // discovery (disks also surface a paired I/O tab via dios[]).
  const focusDisks: HistoryDiskSpec[] = [
    { id: 'C:', pctBase: 73, ioReadBpsBase: 3_000_000, ioWriteBpsBase: 4_000_000, maxBps: 500_000_000 },
    { id: 'D:', pctBase: 61, ioReadBpsBase: 80_000_000, ioWriteBpsBase: 12_000_000, maxBps: 3_000_000_000 },
  ];
  const focusGpus: HistoryGpuSpec[] = [
    { id: 'NVIDIA RTX A5000', usageBase: 55, tempBase: 64 },
  ];
  const focusNics: HistoryNicSpec[] = [
    { id: 'Ethernet 1', txBpsBase: 250_000, rxBpsBase: 1_200_000, txUtilBase: 2, rxUtilBase: 12 },
    { id: 'Tailscale', txBpsBase: 80_000, rxBpsBase: 95_000, txUtilBase: 0.5, rxUtilBase: 0.6 },
  ];

  const machines: MachineSpec[] = [
    {
      id: focusMachineId,
      metrics: { cpuPct: 64, memPct: 71, memUsedGb: 45.2, gpuPct: 58, diskPct: 73 },
      history: {
        cpuBase: 60, memBase: 70, diskBase: 70, gpuBase: 55, seed: 0xfa11ed1a,
        disks: focusDisks,
        gpus: focusGpus,
        nics: focusNics,
      },
    },
    {
      id: 'lobby-display',
      metrics: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 },
      history: { cpuBase: 22, memBase: 38, diskBase: 40, gpuBase: 18, seed: 0xb00b1e57 },
    },
    {
      id: 'museum-kiosk-1',
      metrics: { cpuPct: 41, memPct: 53, memUsedGb: 16.8, gpuPct: 31, diskPct: 56 },
      history: { cpuBase: 40, memBase: 52, diskBase: 55, gpuBase: 30, seed: 0xdeadbeef },
    },
    {
      id: 'unreal-render-1',
      metrics: { cpuPct: 78, memPct: 82, memUsedGb: 52.0, gpuPct: 88, diskPct: 64 },
      history: { cpuBase: 75, memBase: 80, diskBase: 60, gpuBase: 85, seed: 0xc0ffee42 },
    },
  ];

  for (const m of machines) {
    await seedMachine(siteId, m.id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, m.id, m.metrics, 5);
    await writeMetricsHistory(siteId, m.id, m.history);
  }

  return {
    siteId,
    machineId: focusMachineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * metrics_history bucket consumed by useSparklineData / useAllSparklineData /
 * useHistoricalMetrics:
 *   sites/{siteId}/machines/{machineId}/metrics_history/{YYYY-MM-DD}
 *     { samples: [{ t, c, m, d, g, ct, gt, ds[], gs[], n[], dios[] }, ...] }
 * Shape mirrors functions/src/metricsHistory.ts so per-device tabs and paired
 * overlay lines match production. Bucket id matches FIXED_NOW because specs
 * page.clock.install before navigating.
 */
interface HistoryDiskSpec {
  id: string;
  pctBase: number;
  /** Bytes-per-second base for IO read/write traces; defaults to an idle rate. */
  ioReadBpsBase?: number;
  ioWriteBpsBase?: number;
  /** Hardware-class peak bandwidth ceiling for the `_io_*_pct` lines. */
  maxBps?: number;
}
interface HistoryGpuSpec {
  id: string;
  usageBase: number;
  tempBase?: number;
}
interface HistoryNicSpec {
  id: string;
  txBpsBase?: number;
  rxBpsBase?: number;
  txUtilBase?: number;
  rxUtilBase?: number;
}

async function writeMetricsHistory(
  siteId: string,
  machineId: string,
  opts: {
    cpuBase?: number;
    memBase?: number;
    diskBase?: number;
    gpuBase?: number;
    seed?: number;
    sampleCount?: number;
    /** When omitted, derived from `cpuBase` (40 + cpuBase * 0.35). */
    cpuTempBase?: number;
    /** When omitted, derived from `gpuBase` (48 + gpuBase * 0.32). */
    gpuTempBase?: number;
    /** Per-disk usage entries. Defaults to `[{ id: 'C:', pctBase: diskBase }]`. */
    disks?: HistoryDiskSpec[];
    /** Per-GPU entries. Defaults to one entry named `NVIDIA RTX A5000` mapped to `gpuBase`. */
    gpus?: HistoryGpuSpec[];
    /** Per-NIC entries. Defaults to a single low-traffic Ethernet 1 NIC. */
    nics?: HistoryNicSpec[];
  } = {},
): Promise<void> {
  const {
    cpuBase = 50,
    memBase = 60,
    diskBase = 45,
    gpuBase = 35,
    seed = 0xfa11ed1a,
    sampleCount = 60,
    cpuTempBase = 40 + cpuBase * 0.35,
    gpuTempBase = 48 + gpuBase * 0.32,
    disks = [{ id: 'C:', pctBase: diskBase, maxBps: 500_000_000 }],
    gpus = [{ id: 'NVIDIA RTX A5000', usageBase: gpuBase }],
    nics = [{ id: 'Ethernet 1' }],
  } = opts;
  const rng = makePrng(seed);
  const bucketId = new Date(FIXED_NOW_MS).toISOString().split('T')[0];

  // Sample `t` must be SECONDS: useHistoricalMetrics does `sample.t * 1000`,
  // so milliseconds plot the chart off-screen at year 50000+.
  const nowSec = Math.floor(FIXED_NOW_MS / 1000);
  type DiskSample = { i: string; p: number };
  type GpuSample = { i: string; u: number; t?: number };
  type NicSample = { i: string; tx: number; rx: number; tu: number; ru: number };
  type DiskIOSample = { i: string; rb: number; wb: number; bu: number; mb: number };
  type Sample = {
    t: number;
    c: number;
    m: number;
    d: number;
    g: number;
    ct: number;
    gt: number;
    ds: DiskSample[];
    gs: GpuSample[];
    n: NicSample[];
    dios: DiskIOSample[];
  };
  const samples: Sample[] = [];

  for (let i = 0; i < sampleCount; i++) {
    const minutesAgo = sampleCount - i;
    const cpu = clamp(cpuBase + (rng() - 0.5) * 30, 5, 95);
    const memory = clamp(memBase + (rng() - 0.5) * 20, 30, 95);
    const diskAgg = clamp(diskBase + (rng() - 0.5) * 15, 20, 90);
    const gpuAgg = clamp(gpuBase + (rng() - 0.5) * 25, 5, 95);
    const activity = (cpuBase + gpuBase) / 100; // 0 - ~2

    const ds: DiskSample[] = disks.map((d) => ({
      i: d.id,
      p: clamp(d.pctBase + (rng() - 0.5) * 12, 10, 95),
    }));
    const gs: GpuSample[] = gpus.map((g) => {
      const u = clamp(g.usageBase + (rng() - 0.5) * 25, 5, 95);
      const t = clamp((g.tempBase ?? 48 + g.usageBase * 0.32) + (rng() - 0.5) * 4, 35, 92);
      return { i: g.id, u, t };
    });
    const n: NicSample[] = nics.map((nic) => {
      const tx = Math.round((nic.txBpsBase ?? 250_000) * (0.5 + rng() * 1.0));
      const rx = Math.round((nic.rxBpsBase ?? 1_200_000) * (0.5 + rng() * 1.0));
      const tu = clamp((nic.txUtilBase ?? 2) + (rng() - 0.5) * 1.5, 0, 80);
      const ru = clamp((nic.rxUtilBase ?? 12) + (rng() - 0.5) * 4, 0, 80);
      return { i: nic.id, tx, rx, tu, ru };
    });
    const dios: DiskIOSample[] = disks.map((d) => {
      const baseRead = d.ioReadBpsBase ?? 3_000_000;
      const baseWrite = d.ioWriteBpsBase ?? 4_000_000;
      const maxBps = d.maxBps ?? 500_000_000;
      const rb = Math.max(0, Math.round(baseRead * activity * (0.6 + rng() * 0.8)));
      const wb = Math.max(0, Math.round(baseWrite * activity * (0.5 + rng() * 0.8)));
      const bu = clamp(8 * activity + rng() * 6, 0, 95);
      return { i: d.id, rb, wb, bu, mb: maxBps };
    });

    samples.push({
      t: nowSec - minutesAgo * 60,
      c: cpu,
      m: memory,
      d: diskAgg,
      g: gpuAgg,
      ct: clamp(cpuTempBase + (cpu - cpuBase) * 0.4 + (rng() - 0.5) * 3, 35, 90),
      gt: clamp(gpuTempBase + (gpuAgg - gpuBase) * 0.32 + (rng() - 0.5) * 3, 35, 92),
      ds,
      gs,
      n,
      dios,
    });
  }

  await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('metrics_history')
    .doc(bucketId)
    .set({ samples });
}

/**
 * Card view focused on `td-control-room`'s mid-restart touchdesigner process;
 * surrounding cards carry their own running process sets.
 */
async function seedControlProcessRestarting(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const focusMachineId = 'td-control-room';
  const focusProcessId = 'proc-touchdesigner-main';
  await seedScreenshotSite(siteId, 'flagship');

  type MachineSpec = {
    id: string;
    metrics: { cpuPct: number; memPct: number; memUsedGb: number; gpuPct: number; diskPct: number };
    history: { cpuBase: number; memBase: number; diskBase: number; gpuBase: number; seed: number };
    processes: ProcEntry[];
  };

  const machines: MachineSpec[] = [
    {
      id: focusMachineId,
      metrics: { cpuPct: 38, memPct: 52, memUsedGb: 16.6, gpuPct: 41, diskPct: 47 },
      history: { cpuBase: 36, memBase: 50, diskBase: 47, gpuBase: 40, seed: 0xc0ffee01 },
      processes: [
        {
          id: focusProcessId,
          name: 'touchdesigner.exe',
          status: 'LAUNCHING',
          pid: 4218,
          exe_path: 'C:\\Program Files\\Derivative\\TouchDesigner\\bin\\TouchDesigner.exe',
          file_path: 'C:\\Owlette\\projects\\stage-show\\main.toe',
          cwd: 'C:\\Owlette\\projects\\stage-show',
          last_updated_offset: 4,
          responsive: false,
        },
        {
          id: 'proc-obs-stream',
          name: 'obs64.exe',
          status: 'RUNNING',
          pid: 5102,
          exe_path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
          cwd: 'C:\\Program Files\\obs-studio\\bin\\64bit',
          last_updated_offset: 600,
          responsive: true,
        },
      ],
    },
    {
      id: 'media-server-stage',
      metrics: { cpuPct: 64, memPct: 71, memUsedGb: 45.2, gpuPct: 58, diskPct: 73 },
      history: { cpuBase: 62, memBase: 70, diskBase: 70, gpuBase: 55, seed: 0xc0ffee02 },
      processes: [
        {
          id: 'proc-mediaserver-main',
          name: 'media-server.exe',
          status: 'RUNNING',
          pid: 7320,
          exe_path: 'C:\\Owlette\\bin\\media-server.exe',
          cwd: 'C:\\Owlette\\bin',
          last_updated_offset: 12,
          responsive: true,
        },
      ],
    },
    {
      id: 'mainstage-led',
      metrics: { cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51 },
      history: { cpuBase: 28, memBase: 40, diskBase: 50, gpuBase: 35, seed: 0xc0ffee03 },
      processes: [
        {
          id: 'proc-resolume',
          name: 'avenue.exe',
          status: 'RUNNING',
          pid: 9024,
          exe_path: 'C:\\Program Files\\Resolume Avenue\\Avenue.exe',
          cwd: 'C:\\Program Files\\Resolume Avenue',
          last_updated_offset: 30,
          responsive: true,
        },
      ],
    },
    {
      id: 'lobby-display',
      metrics: { cpuPct: 22, memPct: 38, memUsedGb: 12.1, gpuPct: 18, diskPct: 41 },
      history: { cpuBase: 22, memBase: 38, diskBase: 40, gpuBase: 18, seed: 0xc0ffee04 },
      processes: [
        {
          id: 'proc-signage-player',
          name: 'BrightSignSigner.exe',
          status: 'RUNNING',
          pid: 1180,
          exe_path: 'C:\\Owlette\\signage\\BrightSignSigner.exe',
          cwd: 'C:\\Owlette\\signage',
          last_updated_offset: 8,
          responsive: true,
        },
      ],
    },
  ];

  for (const m of machines) {
    await seedMachine(siteId, m.id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, m.id, m.metrics, 5);
    await writeMetricsHistory(siteId, m.id, m.history);
    await writeMachineProcesses(siteId, m.id, m.processes);
  }

  return {
    siteId,
    machineId: focusMachineId,
    processId: focusProcessId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/** Roost mid-rollout (3 of 10 complete). tier=pro so the siteTier gate passes. */
async function seedDeployRoostRolling(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  await seedScreenshotSite(siteId, 'flagship');

  const machineIds = [
    'lobby-display', 'museum-kiosk-1', 'museum-kiosk-2', 'media-server-stage',
    'nyc-signage-01', 'unreal-render-1', 'td-control-room', 'touring-rig-04',
    'lobby-2', 'mainstage-led',
  ];
  for (const id of machineIds) {
    await seedMachine(siteId, id, { heartbeatOffsetSec: 5 });
    await writeMachineMetrics(siteId, id, {
      cpuPct: 30, memPct: 45, memUsedGb: 14.5, gpuPct: 22, diskPct: 50,
    }, 5);
  }

  // Roost with a current version and 10 targets.
  const roostId = 'stage-show';
  await seedRoostWithVersionHistory(siteId, roostId, {
    name: 'stage show',
    targets: machineIds,
    extractPath: 'C:\\Owlette\\projects\\stage-show',
    versionCount: 4,
    descriptions: [
      'initial version',
      'lighting cue tweaks',
      'audio sync fixes',
      'spring tour build',
    ],
  });

  // Mixed-status deployments; the spec expands the in-flight row.
  const db = getAdminDb();
  const deploymentsRef = db.collection('sites').doc(siteId).collection('deployments');

  // 1) IN-PROGRESS — the row the spec expands.
  await deploymentsRef.doc('depl-stage-show-v4').set({
    name: 'stage show v4',
    installer_name: 'stage-show.zip',
    installer_url: 'https://e2e-seed.test/roost/stage-show.zip',
    silent_flags: '',
    status: 'in_progress',
    createdAt: tsAgo(60 * 8),
    targets: machineIds.map((mid, idx) => {
      if (idx < 3) {
        return {
          machineId: mid,
          status: 'completed',
          progress: 100,
          completedAt: tsAgo(60 * 5 - idx * 30),
        };
      }
      if (idx === 3) {
        return { machineId: mid, status: 'installing', progress: 64 };
      }
      return { machineId: mid, status: 'pending' };
    }),
  });

  // 2) COMPLETED — finished 2 days ago across the same fleet.
  await deploymentsRef.doc('depl-stage-show-v3').set({
    name: 'stage show v3',
    installer_name: 'stage-show.zip',
    installer_url: 'https://e2e-seed.test/roost/stage-show-v3.zip',
    silent_flags: '',
    status: 'completed',
    createdAt: tsAgo(60 * 60 * 48),
    completedAt: tsAgo(60 * 60 * 47),
    targets: machineIds.map((mid, idx) => ({
      machineId: mid,
      status: 'completed',
      progress: 100,
      completedAt: tsAgo(60 * 60 * 47 - idx * 60),
    })),
  });

  // 3) FAILED — partial rollout that hit an installer error on one machine.
  await deploymentsRef.doc('depl-touchdesigner-driver-update').set({
    name: 'touchdesigner 2024.40000 driver bump',
    installer_name: 'TouchDesigner-2024.40000.exe',
    installer_url: 'https://e2e-seed.test/roost/td-2024.40000.exe',
    silent_flags: '/SILENT',
    status: 'failed',
    createdAt: tsAgo(60 * 60 * 5),
    completedAt: tsAgo(60 * 60 * 4),
    targets: machineIds.slice(0, 4).map((mid, idx) => {
      if (idx < 2) {
        return { machineId: mid, status: 'completed', progress: 100, completedAt: tsAgo(60 * 60 * 4 + 60) };
      }
      if (idx === 2) {
        return { machineId: mid, status: 'failed', progress: 87, error: 'msi exit code 1603 (fatal install error)' };
      }
      return { machineId: mid, status: 'cancelled', progress: 0 };
    }),
  });

  // 4) SCHEDULED — queued for later tonight.
  await deploymentsRef.doc('depl-content-pack-spring').set({
    name: 'spring content pack',
    installer_name: 'content-pack-spring.zip',
    installer_url: 'https://e2e-seed.test/roost/content-pack-spring.zip',
    silent_flags: '',
    status: 'scheduled',
    createdAt: tsAgo(60 * 60 * 1),
    scheduledFor: Timestamp.fromMillis(FIXED_NOW_MS + 60 * 60 * 6 * 1000),
    targets: machineIds.slice(0, 6).map((mid) => ({
      machineId: mid,
      status: 'pending',
      progress: 0,
    })),
  });

  return {
    siteId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * Conversation ids `diagnose-cortex-chat` writes, so a spec or a capture scene
 * navigates to `/hoot/<id>` without re-deriving the naming. `ScreenshotFixture`
 * carries only site/machine/process ids, and widening it for one scenario would
 * push four optional fields onto every other consumer.
 *
 * The `cortex` spelling is the deliberate wire name (`lib/hoot/WIRE_NAMES.md`);
 * the product and every word on screen say hoot.
 */
export const hootFocusConversationId = (siteId: string): string =>
  `screenshot-cortex-${siteId}`;
/** Tier-3 approve/deny card awaiting a decision. */
export const hootApprovalConversationId = (siteId: string): string =>
  `screenshot-cortex-approval-${siteId}`;
/** A tool part left executing, so the turn survives a page reload. */
export const hootRunningConversationId = (siteId: string): string =>
  `screenshot-cortex-running-${siteId}`;
/** Autonomous investigation — carries the sidebar's `auto` badge. */
export const hootAutonomousConversationId = (siteId: string): string =>
  `screenshot-cortex-auto-${siteId}`;

/** Hoot chat with a realistic incident-investigation conversation. */
async function seedDiagnoseHootChat(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'media-server-stage';
  const userId = TEST_USERS.admin.uid;
  await seedScreenshotSite(siteId, 'flagship', userId);
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 24, memPct: 36, memUsedGb: 11.5, gpuPct: 18, diskPct: 43,
  }, 5);

  const db = getAdminDb();
  // User's LLM key bypass — without it the hoot page shows a no-key gate.
  await db.collection('users').doc(userId).collection('settings').doc('llm').set({
    provider: 'openai',
    model: 'gpt-4o-mini',
    hasKey: true,
    updatedAt: tsAgo(60 * 60 * 24 * 3),
  });

  // Focus conversation — the spec opens this one for the screenshot.
  const focusConversationId = hootFocusConversationId(siteId);
  await db.collection('chats').doc(focusConversationId).set({
    userId,
    siteId,
    title: '03:14 incident — media-server-stage',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'msg-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'what crashed at 3am?' }],
      },
      {
        id: 'msg-assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'media-server-stage crashed at 03:14 — touchdesigner.exe exit code -1073741819 (access violation). it was auto-restarted at 03:14:08 and has been stable since. the upstream culprit was a CUDA driver hiccup on GPU0; no other machines were affected.',
          },
          {
            type: 'tool-checkLogs',
            toolCallId: 'tool-checklogs-1',
            state: 'output-available',
            args: { machineId, since: '03:00', until: '03:30' },
            output: { matches: 4, level: 'error' },
          },
        ],
      },
      {
        id: 'msg-user-2',
        role: 'user',
        parts: [{ type: 'text', text: 'is it likely to recur tonight?' }],
      },
      {
        id: 'msg-assistant-2',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'low risk for tonight — the GPU temperature peaked at 84°C right before the crash, and it has been below 70°C since the restart. i recommend pinning the driver to 552.22 (current is 555.85) until the next patch window.',
          },
        ],
      },
    ],
    createdAt: tsAgo(60 * 60 * 9),
    updatedAt: tsAgo(60 * 30),
  });

  // Tier-3 approval gate — its own conversation, NOT a fourth turn on the focus
  // thread: `cortex-chat.spec.ts` and `diagnose.spec.ts` frame that thread for
  // docs/marketing stills, and an amber approve/deny banner inside it would
  // rewrite both PNGs.
  //
  // What the separation protects is the TRANSCRIPT, not every pixel.
  // `cortex-chat.spec.ts` scopes its shot to `main` (:34-37) while the
  // conversation list is an `<aside>` sibling, so it is fully insulated.
  // `diagnose.spec.ts` shoots the viewport (`fullPage: false`, :74-77) with that
  // sidebar in frame, so `preview-diagnose.png` DOES pick up the three
  // conversations added below — accepted: the framed answer is unchanged and the
  // landing asset re-bakes on the next `npm run screenshots`.
  //
  // `state: 'approval-requested'` + `approval.id` is what ChatWindow.tsx reads
  // to hand ToolCallCard `approvalState: 'requested'`.
  await db.collection('chats').doc(hootApprovalConversationId(siteId)).set({
    userId,
    siteId,
    title: 'free up disk on media-server-stage',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'msg-approval-user-1',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'clear the render cache on media-server-stage — it is at 88% disk.',
          },
        ],
      },
      {
        id: 'msg-approval-assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'the cache lives outside the paths my file tools can reach, so this needs a shell command. it will delete everything under C:\\Owlette\\projects\\stage-show\\renders older than 30 days — nothing the current roost manifest references.',
          },
          {
            type: 'tool-run_powershell',
            toolCallId: 'tool-run-powershell-1',
            state: 'approval-requested',
            approval: { id: 'approval-run-powershell-1' },
            args: {
              machineId,
              script:
                "Get-ChildItem 'C:\\Owlette\\projects\\stage-show\\renders' -Recurse -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Force",
            },
          },
        ],
      },
    ],
    createdAt: tsAgo(60 * 25),
    updatedAt: tsAgo(60 * 4),
  });

  // Async turns — a tool part still executing. `running` in ChatWindow.tsx is
  // derived (no result, not awaiting approval, not denied), so a part with a
  // state that never resolves is the whole trick; it survives a reload, which
  // is exactly what ep12 b07 films. The matching `toolCommands` entry that
  // would add a per-tool "cancel" button comes from the live turn runner and
  // cannot be seeded — see the scene's note.
  await db.collection('chats').doc(hootRunningConversationId(siteId)).set({
    userId,
    siteId,
    title: 'restart the show stack',
    category: 'Operations',
    targetType: 'machine',
    targetMachineId: machineId,
    machineName: machineId,
    source: 'user',
    messages: [
      {
        id: 'msg-running-user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'restart touchdesigner on media-server-stage.' }],
      },
      {
        id: 'msg-running-assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'restarting touchdesigner now — i will confirm once it reports back.' },
          {
            type: 'tool-restart_process',
            toolCallId: 'tool-restart-process-1',
            state: 'input-available',
            args: { machineId, processName: 'TouchDesigner' },
          },
        ],
      },
    ],
    createdAt: tsAgo(60 * 3),
    updatedAt: tsAgo(20),
  });

  // Autonomous investigation — the `auto` badge ep12 b08 frames in the sidebar.
  // There is no dashboard control that turns autonomous mode on, so the beat
  // films the RESULT, never a switch.
  await db.collection('chats').doc(hootAutonomousConversationId(siteId)).set({
    siteId,
    title: 'auto: touchdesigner crash on td-control-room',
    category: 'Autonomous',
    targetType: 'machine',
    targetMachineId: 'td-control-room',
    machineName: 'td-control-room',
    source: 'autonomous',
    autonomousSummary:
      'touchdesigner exited 0xC0000005 at 03:14 and auto-restarted; no operator action needed.',
    messages: [
      {
        id: 'msg-auto-assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'text',
            text:
              'touchdesigner exited with 0xC0000005 at 03:14 and the agent relaunched it 8 seconds later. logs point at the same CUDA driver fault as the earlier incident; the machine has been stable since. no escalation raised.',
          },
        ],
      },
    ],
    createdAt: tsAgo(60 * 60 * 11),
    updatedAt: tsAgo(60 * 60 * 10),
  });

  // Sidebar fillers — 1-turn conversations so the sidebar reads as real.
  const fillerConversations: Array<{
    id: string;
    title: string;
    category: string;
    machineName: string;
    targetMachineId: string | null;
    userText: string;
    assistantText: string;
    createdAtSecAgo: number;
    updatedAtSecAgo: number;
  }> = [
    {
      id: 'screenshot-cortex-driver-audit',
      title: 'nvidia driver audit across the fleet',
      category: 'Operations',
      machineName: 'all machines',
      targetMachineId: null,
      userText: 'which machines are still on nvidia 552.22?',
      assistantText:
        '4 machines are still on 552.22: media-server-stage, mainstage-led, unreal-render-1, td-control-room. the rest are on 555.85.',
      createdAtSecAgo: 60 * 60 * 24 * 2 + 60 * 30,
      updatedAtSecAgo: 60 * 60 * 24 * 2,
    },
    {
      id: 'screenshot-cortex-disk-warning',
      title: 'disk space warning — museum-kiosk-2',
      category: 'Health',
      machineName: 'museum-kiosk-2',
      targetMachineId: 'museum-kiosk-2',
      userText: "museum-kiosk-2 says it's at 92% disk. what's eating it?",
      assistantText:
        '88GB is in C:\\Owlette\\projects\\stage-show\\renders — looks like the auto-render cache hasn\'t been pruned since february. safe to clear; nothing in there is referenced by the current roost manifest.',
      createdAtSecAgo: 60 * 60 * 5,
      updatedAtSecAgo: 60 * 60 * 4,
    },
    {
      id: 'screenshot-cortex-restart-sequence',
      title: 'startup sequence for opening night',
      category: 'Operations',
      machineName: 'mainstage-led',
      targetMachineId: 'mainstage-led',
      userText: 'walk me through the boot order for mainstage-led on opening night.',
      assistantText:
        'sequence: 1) BrightSignSigner waits 8s for the LED matrix to handshake, 2) avenue.exe launches with the spring-tour.avc composition, 3) td-control-room starts main.toe and signals avenue over osc once it\'s ready. total time-to-show is roughly 45 seconds from cold boot.',
      createdAtSecAgo: 60 * 60 * 24 * 1,
      updatedAtSecAgo: 60 * 60 * 22,
    },
    {
      id: 'screenshot-cortex-license-check',
      title: 'touchdesigner license expiry',
      category: 'Compliance',
      machineName: 'all machines',
      targetMachineId: null,
      userText: 'when do our touchdesigner pro licenses expire?',
      assistantText:
        'all 6 td-pro licenses renew on 2026-09-14. the seat assigned to td-control-room is the only one set to auto-renew; the rest will need a manual nudge in derivative\'s portal in september.',
      createdAtSecAgo: 60 * 60 * 24 * 4,
      updatedAtSecAgo: 60 * 60 * 24 * 4,
    },
  ];

  for (const c of fillerConversations) {
    await db.collection('chats').doc(c.id).set({
      userId,
      siteId,
      title: c.title,
      category: c.category,
      targetType: c.targetMachineId ? 'machine' : 'site',
      targetMachineId: c.targetMachineId,
      machineName: c.machineName,
      source: 'user',
      messages: [
        {
          id: `${c.id}-msg-user-1`,
          role: 'user',
          parts: [{ type: 'text', text: c.userText }],
        },
        {
          id: `${c.id}-msg-assistant-1`,
          role: 'assistant',
          parts: [{ type: 'text', text: c.assistantText }],
        },
      ],
      createdAt: tsAgo(c.createdAtSecAgo),
      updatedAt: tsAgo(c.updatedAtSecAgo),
    });
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * 4-monitor 2×2 mosaic. Profile at machines/{id}/hardware/display; assignment
 * at config/{siteId}/machines/{id}.displays.assigned (per setDisplayLayout).
 */
async function seedDisplayLayoutEditor(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'mainstage-led';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, {
    heartbeatOffsetSec: 5,
    monitorCount: 0, // we'll write a custom 4-monitor profile below
  });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51,
  }, 5);

  await writeFourMonitorProfile(siteId, machineId);

  // Assigned layout — what this machine should look like.
  const db = getAdminDb();
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        displays: {
          assigned: {
            monitors: buildFourMonitorTopology(machineId),
            capturedAt: tsAgo(60 * 60 * 24 * 2),
            capturedBy: 'admin@e2e.test',
          },
          autoRestore: { enabled: true, enabledBy: 'admin@e2e.test' },
          remoteApplyEnabled: true,
        },
      },
      { merge: true },
    );

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

interface MonitorTopologyEntry {
  id: string;
  edidHash: string;
  manufacturerId: string;
  productCode: string;
  serialNumber: string;
  friendlyName: string;
  position: { x: number; y: number };
  resolution: { width: number; height: number };
  refreshHz: number;
  rotation: number;
  scalePct: number;
  primary: boolean;
  connectionType: string;
  adapterLuid: string;
  targetId: number;
}

/** Four 1920×1080 monitors arranged 2×2 (top-left primary). */
function buildFourMonitorTopology(machineId: string): MonitorTopologyEntry[] {
  const positions = [
    { x: 0,    y: 0,    primary: true },
    { x: 1920, y: 0,    primary: false },
    { x: 0,    y: 1080, primary: false },
    { x: 1920, y: 1080, primary: false },
  ];
  return positions.map((p, i) => ({
    id: `MONITOR\\MAIN${i}`,
    edidHash: `hash-${machineId}-${i}`,
    manufacturerId: 'SAM',
    productCode: `0E0${i}`,
    serialNumber: `SN-${machineId}-${i}`,
    friendlyName: `Mainstage ${i + 1}`,
    position: { x: p.x, y: p.y },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: p.primary,
    connectionType: 'dp',
    adapterLuid: '0:1',
    targetId: i,
  }));
}

async function writeFourMonitorProfile(
  siteId: string,
  machineId: string,
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('hardware')
    .doc('display')
    .set({
      schemaVersion: 1,
      signatureHash: `sig-${machineId}`,
      capturedAt: FIXED_NOW_MS,
      monitors: buildFourMonitorTopology(machineId),
      mosaicActive: false,
    });
}

/**
 * Schedule editor state: config/{siteId}/machines/{id}.rebootSchedule,
 * config/{siteId}/schedule_presets/*, sites/{siteId}/alertRules/*.
 */
async function seedAutomateScheduleEditor(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'lobby-display';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 19, memPct: 31, memUsedGb: 9.9, gpuPct: 12, diskPct: 36,
  }, 5);
  await seedMachine(siteId, 'media-server-stage', { heartbeatOffsetSec: 5 });
  await writeMachineMetrics(siteId, 'media-server-stage', {
    cpuPct: 92, memPct: 78, memUsedGb: 49.9, gpuPct: 88, diskPct: 81,
  }, 5);

  const db = getAdminDb();
  // Reboot schedule on the lobby display — fires every Monday at 04:00.
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set(
      {
        rebootSchedule: {
          enabled: true,
          entries: [
            { id: 'sched-monday-0400', days: ['mon'], time: '04:00' },
            { id: 'sched-friday-2300', days: ['fri'], time: '23:00' },
          ],
        },
      },
      { merge: true },
    );

  // Schedule presets — one custom on top of the built-ins.
  await db
    .collection('config')
    .doc(siteId)
    .collection('schedule_presets')
    .doc('preset-museum-hours')
    .set({
      name: 'museum hours',
      description: 'tue–sun 10am–5pm (closed mon)',
      blocks: [
        {
          days: ['tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
          ranges: [{ start: '10:00', stop: '17:00' }],
          colorIndex: 2,
        },
      ],
      isBuiltIn: false,
      order: 100,
      createdBy: TEST_USERS.admin.uid,
      createdAt: tsAgo(60 * 60 * 24 * 14),
      updatedAt: tsAgo(60 * 60 * 24 * 7),
    });

  // Alert rule — fires when CPU > 90% for 5 minutes on media-server-stage.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('alertRules')
    .doc('rule-cpu-stage')
    .set({
      kind: 'threshold',
      machineId: 'media-server-stage',
      metric: 'cpu',
      comparator: 'gt',
      threshold: 90,
      durationSec: 300,
      action: 'restart_process',
      processId: 'proc-touchdesigner-main',
      enabled: true,
      createdAt: tsAgo(60 * 60 * 24 * 2),
      updatedAt: tsAgo(60 * 60 * 6),
    });

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * Talons list state: seven automations under `sites/{siteId}/talons`, chosen to
 * span every trigger kind (schedule entries, threshold, event — one of them
 * delayed), both condition kinds, and all four output families (email, webhook,
 * hoot, command). One talon is scoped to every machine, the rest to a subset,
 * so the scope column reads as a real fleet rather than a demo.
 *
 * Ordering is not incidental: `useTalons` sorts by name client-side, so the
 * seeded names below are already in rendered order. Client writes are denied by
 * firestore.rules (talons are server-mediated); the Admin SDK bypasses that,
 * which is why these are written here rather than through the api.
 *
 * `lastRunAt` values hang off FIXED_NOW so the "last run" column is stable under
 * the spec's pinned clock. The wall check's last run is `skipped` on purpose —
 * a visual-check `pass` short-circuits before the outputs run, so that IS what a
 * healthy wall looks like in the history.
 */
async function seedAutomateTalonsList(): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'lobby-wall';
  const machineIds = [machineId, 'gallery-projector', 'media-server-stage', 'render-node-01'];
  await seedScreenshotSite(siteId, 'flagship');

  // The talons page reads `machines.length` only (to render "1 of 4 machines"),
  // so these need no metrics and no display profile.
  for (const id of machineIds) {
    await seedMachine(siteId, id, { heartbeatOffsetSec: 5, monitorCount: 0 });
  }

  // Shared authorship/bookkeeping half of every talon below.
  const authored: Pick<
    TalonDoc,
    'schemaVersion' | 'createdBy' | 'createdVia' | 'consecutiveFailures' | 'createdAt' | 'updatedAt'
  > = {
    schemaVersion: 1,
    createdBy: TEST_USERS.admin.uid,
    createdVia: 'ui',
    consecutiveFailures: 0,
    createdAt: tsAgo(60 * 60 * 24 * 45),
    updatedAt: tsAgo(60 * 60 * 24 * 6),
  };

  const talons: Array<{ id: string; doc: TalonDoc }> = [
    {
      id: 'talon-doors-open',
      doc: {
        ...authored,
        name: 'doors open — lobby wall is live',
        description: 'before opening, look at the wall and make sure the show is on screen',
        enabled: true,
        trigger: {
          type: 'schedule',
          entries: [
            { id: 'entry-doors-open', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '09:45' },
          ],
        },
        condition: {
          type: 'visual_check',
          expectation:
            'the wall should be showing the content loop. it should not show the windows ' +
            'desktop, an error dialog, or a black screen.',
          monitor: 1,
        },
        outputs: [
          {
            type: 'cortex',
            directive:
              'the lobby wall is not showing the show. restart touchdesigner on it and tell ' +
              'me what you found.',
            allowActions: true,
          },
          { type: 'email' },
        ],
        scope: { machineIds: [machineId] },
        cooldownMinutes: 60,
        // 09:45 America/Los_Angeles = 16:45 UTC, the next occurrence after FIXED_NOW.
        nextRunAt: Timestamp.fromMillis(FIXED_NOW_MS + (2 * 60 + 15) * 60 * 1000),
        lastRunAt: tsAgo(60 * 60 * 4 + 60 * 45),
        lastRunStatus: 'skipped',
        lastRunId: 'run-doors-open',
      },
    },
    {
      id: 'talon-gpu-pinned',
      doc: {
        ...authored,
        name: 'gpu pinned on the render node',
        description: 'page show ops when the render machines stop keeping up',
        enabled: true,
        trigger: { type: 'threshold', metric: 'gpu_percent', operator: '>=', value: 95 },
        condition: { type: 'none' },
        outputs: [
          { type: 'webhook', url: 'https://hooks.showops.example.com/owlette/gpu' },
          { type: 'email' },
        ],
        scope: { machineIds: ['render-node-01', 'media-server-stage'] },
        cooldownMinutes: 30,
        lastRunAt: tsAgo(60 * 60 * 2 + 60 * 20),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-gpu-pinned',
      },
    },
    {
      id: 'talon-nightly-restart',
      doc: {
        ...authored,
        name: 'nightly restart — media servers',
        description: 'restart the show stack at 4am so every day starts from a known state',
        enabled: true,
        trigger: {
          type: 'schedule',
          entries: [
            { id: 'entry-nightly-restart', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '04:00' },
          ],
        },
        condition: { type: 'none' },
        outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
        scope: { machineIds: ['media-server-stage', 'render-node-01'] },
        cooldownMinutes: 720,
        // 04:00 America/Los_Angeles = 11:00 UTC, so the next one is tomorrow.
        nextRunAt: Timestamp.fromMillis(FIXED_NOW_MS + (20 * 60 + 30) * 60 * 1000),
        lastRunAt: tsAgo(60 * 60 * 10 + 60 * 30),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-nightly-restart',
      },
    },
    {
      id: 'talon-projector-offline',
      doc: {
        ...authored,
        name: 'projector dropped offline',
        description: 'give it five minutes to come back on its own, then tell the on-call tech',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['machine_offline'], delayMinutes: 5 },
        condition: { type: 'none' },
        outputs: [
          { type: 'email' },
          { type: 'webhook', url: 'https://hooks.showops.example.com/owlette/on-call' },
        ],
        scope: { machineIds: ['gallery-projector'] },
        cooldownMinutes: 15,
        lastRunAt: tsAgo(60 * 60 * 24 * 3),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-projector-offline',
      },
    },
    {
      id: 'talon-crash-recovery',
      doc: {
        ...authored,
        name: 'touchdesigner crash recovery',
        description: 'when the show process dies, put it back before anyone notices',
        enabled: true,
        trigger: { type: 'event', eventTypes: ['process_crash', 'process_start_failed'] },
        condition: { type: 'none' },
        outputs: [
          { type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' },
          { type: 'email' },
        ],
        scope: { machineIds: null },
        cooldownMinutes: 10,
        lastRunAt: tsAgo(60 * 60 * 31),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-crash-recovery',
      },
    },
    {
      id: 'talon-update-guard',
      doc: {
        ...authored,
        name: 'update guard — sundays',
        description: 're-assert the update window and the setup-screen suppression every week',
        enabled: true,
        trigger: {
          type: 'schedule',
          entries: [{ id: 'entry-update-guard', days: ['sun'], time: '07:00' }],
        },
        condition: { type: 'none' },
        outputs: [
          {
            type: 'cortex',
            directive:
              're-assert the update window and suppress the windows setup screens on every ' +
              'machine in this site.',
            allowActions: true,
          },
        ],
        scope: { machineIds: null },
        cooldownMinutes: 1440,
        // 07:00 America/Los_Angeles = 14:00 UTC; FIXED_NOW is a Wednesday, so
        // the next sunday is four days out.
        nextRunAt: Timestamp.fromMillis(FIXED_NOW_MS + (4 * 24 * 60 - 30) * 60 * 1000),
        lastRunAt: tsAgo(60 * 60 * 24 * 3 + 60 * 30),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-update-guard',
      },
    },
    {
      id: 'talon-weekly-health-report',
      doc: {
        ...authored,
        name: 'weekly health report',
        description: 'every monday at 9 am, hoot writes a plain-language health report',
        enabled: true,
        trigger: {
          type: 'schedule',
          entries: [{ id: 'entry-weekly-health-report', days: ['mon'], time: '09:00' }],
        },
        condition: { type: 'none' },
        outputs: [
          {
            type: 'cortex',
            directive:
              'summarize how the fleet ran this week — crashes, restarts, and anything ' +
              'trending the wrong way.',
          },
          { type: 'email' },
        ],
        scope: { machineIds: null },
        cooldownMinutes: 1440,
        // 09:00 America/Los_Angeles = 16:00 UTC on the coming monday (5 days out).
        nextRunAt: Timestamp.fromMillis(FIXED_NOW_MS + (5 * 24 * 60 + 90) * 60 * 1000),
        lastRunAt: tsAgo(60 * 60 * 24 * 2 + 60 * 60 * 5 + 60 * 30),
        lastRunStatus: 'succeeded',
        lastRunId: 'run-weekly-health-report',
      },
    },
  ];

  const talonsRef = getAdminDb().collection('sites').doc(siteId).collection('talons');
  for (const { id, doc } of talons) {
    await talonsRef.doc(id).set(doc);
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

/**
 * Three frames of one display layout for the marketing storyboard:
 * before-apply (drift detected), mid-apply (countdown banner), ack (drift
 * cleared). Same site/machine ids across frames; only the state differs.
 */
async function seedDisplayStoryboardFrame(
  frame: 1 | 2 | 3,
): Promise<ScreenshotFixture> {
  const siteId = 'site-A';
  const machineId = 'mainstage-led';
  await seedScreenshotSite(siteId, 'flagship');
  await seedMachine(siteId, machineId, {
    heartbeatOffsetSec: 5,
    monitorCount: 0,
  });
  await writeMachineMetrics(siteId, machineId, {
    cpuPct: 28, memPct: 42, memUsedGb: 13.4, gpuPct: 35, diskPct: 51,
  }, 5);
  await writeFourMonitorProfile(siteId, machineId);

  const db = getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const configRef = db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);

  // Base assignment — same in all three frames.
  await configRef.set(
    {
      displays: {
        assigned: {
          monitors: buildFourMonitorTopology(machineId),
          capturedAt: tsAgo(60 * 60 * 24 * 2),
          capturedBy: 'admin@e2e.test',
        },
        autoRestore: { enabled: true, enabledBy: 'admin@e2e.test' },
        remoteApplyEnabled: true,
      },
    },
    { merge: true },
  );

  if (frame === 1) {
    // Drift detected — lights the dashboard drift dot and the "apply" CTA.
    await machineRef.set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(5),
          displayDriftCount: 2,
        },
      },
      { merge: true },
    );
  } else if (frame === 2) {
    // Mid-apply — countdown banner anchored 25 seconds into the future.
    await machineRef.set(
      {
        rebooting: false,
        // Display apply doesn't reboot; storyboard-specific countdown field.
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(2),
          displayDriftCount: 2,
        },
      },
      { merge: true },
    );
    await configRef.set(
      {
        displays: {
          remoteApply: {
            inFlight: true,
            scheduledAt: FIXED_NOW_SEC + 25,
            requestedBy: 'admin@e2e.test',
          },
        },
      },
      { merge: true },
    );
  } else {
    // Ack received — drift cleared, last-applied banner stamped.
    await machineRef.set(
      {
        metrics: {
          schemaVersion: 2,
          timestamp: tsAgo(5),
          displayDriftCount: 0,
        },
      },
      { merge: true },
    );
    await configRef.set(
      {
        displays: {
          remoteApply: {
            inFlight: false,
            lastAppliedAt: FIXED_NOW_MS - 8 * 1000,
            lastAppliedBy: 'admin@e2e.test',
          },
        },
      },
      { merge: true },
    );
  }

  return {
    siteId,
    machineId,
    cleanup: () => deleteSiteSubtree(siteId),
  };
}

