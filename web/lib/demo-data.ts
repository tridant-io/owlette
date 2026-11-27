/** Demo data for the public /demo route — realistic machines for screenshots. */

import type {
  Machine,
  Process,
  HardwareProfile,
  CpuProfile,
  DiskProfile,
  GpuProfile,
  NicProfile,
  CpuMetric,
  MemoryMetric,
  DiskMetric,
  GpuMetric,
  NicMetric,
  PrimaryDevices,
  DeviceEntry,
} from '@/hooks/useFirestore';
import type { SparklineDataPoint } from '@/components/charts';
import type { ChartDataPoint } from '@/hooks/useHistoricalMetrics';
import type { TimeRange } from '@/components/charts/TimeRangeSelector';
import type { DisplayProfile, AssignedLayout, MonitorInfo } from '@/hooks/useDisplayState';
import type { MachineOsFamily } from '@/lib/machineOs';
import type { InstallerFile } from '@/lib/installerPlatform';
import type { InstallerVersionInfo } from '@/hooks/useInstallerVersion';

/** Seeded PRNG — demo data must be deterministic across renders. */
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Smooth sine-wave value with noise, clamped to 0-100. */
function generateMetricValue(
  rand: () => number,
  base: number,
  amplitude: number,
  t: number,
  periodHours: number = 24,
): number {
  const sine = Math.sin((2 * Math.PI * t) / (periodHours * 3600));
  const noise = (rand() - 0.5) * amplitude * 0.4;
  return Math.max(0, Math.min(100, base + sine * amplitude + noise));
}

export const DEMO_SITE_ID = 'demo-site';

/**
 * No `schedulesFollowSiteTime` here, deliberately: absence is the legacy
 * machine-local state, so every schedule string on /demo stays byte-identical to
 * what a site that has never opted into site time sees — which is what the
 * screenshots and recorded walkthroughs are showing. Setting it would silently
 * re-word the demo's schedule copy.
 */
export const DEMO_SITE = {
  id: DEMO_SITE_ID,
  name: 'Horizon Museum of Science',
  createdAt: Date.now() - 90 * 24 * 3600 * 1000,
  timezone: 'America/Los_Angeles',
};

interface GpuDef { name: string; usageBase: number; vramTotal: number; vramUsed: number }

/**
 * what each OS calls a demo machine's disks and network adapters, as its agent
 * reports them (agent/src/hardware_profile.py): the system disk and the wired
 * adapter first.
 */
const OS_DEVICES: Record<MachineOsFamily, { disks: readonly string[]; fs: string; nics: readonly string[]; arch: string }> = {
  windows: { disks: ['C:', 'D:'], fs: 'NTFS', nics: ['Ethernet', 'Wi-Fi'], arch: 'x64' },
  macos: { disks: ['/', '/Volumes/Media'], fs: 'apfs', nics: ['en0', 'en1'], arch: 'arm64' },
  linux: { disks: ['/', '/mnt/media'], fs: 'ext4', nics: ['enp3s0', 'wlp4s0'], arch: 'x64' },
};

interface MachineDef {
  id: string;
  osFamily: MachineOsFamily;
  osVersion: string;
  online: boolean;
  /** a mac that went to sleep: offline, but not an outage */
  asleep?: boolean;
  rebooting?: boolean;
  rebootPending?: Machine['rebootPending'];
  /** a restart held until the machine's active hours end (unix seconds) */
  rebootDeferredUntil?: number;
  cpuName: string;
  cpuBase: number;
  memBase: number;
  memTotal: number;
  diskBase: number;
  diskTotal: number;
  /** nvidia or apple only, the gpus the agent reads (shared_utils.get_gpus); an intel one reports nothing */
  gpu?: GpuDef;
  /** Additional GPUs beyond the primary — keyed GPU1, GPU2… in profile + metrics. */
  extraGpus?: GpuDef[];
  network?: { latencyMs: number; packetLoss: number; txBps: number; rxBps: number; txUtil: number; rxUtil: number; linkSpeed: number };
  processes: Omit<Process, 'responsive' | 'last_updated' | 'index' | 'priority' | 'visibility' | 'time_delay' | 'time_to_init' | 'relaunch_attempts' | 'cwd'>[];
  agentVersion: string;
}

/** a machine's disk and adapter ids; kiosks (16 GB or less) have one of each */
function deviceIds(def: MachineDef): { disks: readonly string[]; nics: readonly string[] } {
  const { disks, nics } = OS_DEVICES[def.osFamily];
  return def.memTotal <= 16 ? { disks: disks.slice(0, 1), nics: nics.slice(0, 1) } : { disks, nics };
}

const WIN_PRO = 'Windows 11 Pro 24H2';
const WIN_KIOSK = 'Windows 11 IoT Enterprise LTSC 2024';
const MACOS_VERSION = 'macOS 26.1';

/**
 * the release this build is: next.config.ts reads it from package.json, which
 * sync-versions.js moves on every release. the demo's agents and its latest
 * installer run it, so neither falls behind.
 */
const DEMO_RELEASE = process.env.NEXT_PUBLIC_APP_VERSION ?? '';

const machineDefs: MachineDef[] = [
  {
    id: 'lobby-east-01',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'Intel Core i7-12700K',
    cpuBase: 32, memBase: 58, memTotal: 64, diskBase: 45, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 65, vramTotal: 12, vramUsed: 8.4 },
    network: { latencyMs: 8, packetLoss: 0, txBps: 2500000, rxBps: 15000000, txUtil: 12, rxUtil: 28, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 5234, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/lobby-east.toe' },
      { id: 'p2', name: 'Chrome', status: 'RUNNING', pid: 8291, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://signage.horizon-museum.org' },
    ],
  },
  {
    id: 'lobby-west-02',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'Intel Core i7-12700K',
    cpuBase: 28, memBase: 52, memTotal: 64, diskBase: 43, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 58, vramTotal: 12, vramUsed: 7.1 },
    network: { latencyMs: 9, packetLoss: 0, txBps: 1800000, rxBps: 12000000, txUtil: 10, rxUtil: 22, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 4102, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/lobby-west.toe' },
      { id: 'p2', name: 'Node.js', status: 'RUNNING', pid: 9120, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/data-feed/server.js' },
    ],
  },
  {
    id: 'gallery-main',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'AMD Ryzen 9 7950X',
    cpuBase: 45, memBase: 72, memTotal: 128, diskBase: 38, diskTotal: 4000,
    gpu: { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 78, vramTotal: 24, vramUsed: 18.2 },
    network: { latencyMs: 5, packetLoss: 0, txBps: 45000000, rxBps: 28000000, txUtil: 35, rxUtil: 22, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 3310, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/gallery-immersive.toe' },
      { id: 'p2', name: 'OBS Studio', status: 'RUNNING', pid: 7654, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 2210, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/sensor-bridge/index.js' },
    ],
  },
  {
    id: 'gallery-mac-mini',
    osFamily: 'macos',
    osVersion: MACOS_VERSION,
    online: false,
    asleep: true, // the gallery's mac is asleep after hours
    cpuName: 'Apple M4 Pro',
    cpuBase: 20, memBase: 46, memTotal: 24, diskBase: 52, diskTotal: 1000,
    gpu: { name: 'Apple M4 Pro', usageBase: 35, vramTotal: 24, vramUsed: 6.2 },
    network: { latencyMs: 6, packetLoss: 0, txBps: 900000, rxBps: 6000000, txUtil: 6, rxUtil: 14, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'Resolume Arena', status: 'RUNNING', pid: 1412, autolaunch: true, launch_mode: 'scheduled', exe_path: '/Applications/Resolume Arena/Arena.app', file_path: '' },
    ],
  },
  {
    id: 'theater-projector',
    osFamily: 'windows',
    osVersion: 'Windows 11 Pro 23H2',
    online: true,
    cpuName: 'Intel Core i9-13900K',
    cpuBase: 55, memBase: 65, memTotal: 64, diskBase: 61, diskTotal: 2000,
    gpu: { name: 'NVIDIA RTX PRO 5000 (Blackwell)', usageBase: 82, vramTotal: 16, vramUsed: 13.8 },
    network: { latencyMs: 7, packetLoss: 0, txBps: 35000000, rxBps: 20000000, txUtil: 28, rxUtil: 16, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 6710, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'C:/Projects/theater-show.toe' },
      { id: 'p2', name: 'VLC', status: 'RUNNING', pid: 1190, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: 'C:/Media/preshow-loop.mp4 --fullscreen --loop' },
    ],
  },
  {
    id: 'render-server-01',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'AMD Ryzen Threadripper PRO 7975WX',
    cpuBase: 62, memBase: 68, memTotal: 256, diskBase: 35, diskTotal: 8000,
    gpu: { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 88, vramTotal: 48, vramUsed: 38.4 },
    extraGpus: [
      { name: 'NVIDIA RTX PRO 6000 (Blackwell)', usageBase: 84, vramTotal: 48, vramUsed: 35.1 },
    ],
    network: { latencyMs: 4, packetLoss: 0, txBps: 80000000, rxBps: 60000000, txUtil: 65, rxUtil: 48, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 8801, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: 'D:/Projects/render-farm.toe' },
      { id: 'p2', name: 'OBS Studio', status: 'RUNNING', pid: 8802, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 8803, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/render-queue/worker.js' },
    ],
  },
  {
    id: 'kiosk-entrance-1',
    osFamily: 'windows',
    osVersion: WIN_KIOSK,
    online: true,
    cpuName: 'Intel Core i5-12400',
    cpuBase: 18, memBase: 42, memTotal: 16, diskBase: 55, diskTotal: 512,
    network: { latencyMs: 12, packetLoss: 0, txBps: 500000, rxBps: 3000000, txUtil: 4, rxUtil: 8, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'Chrome', status: 'RUNNING', pid: 4450, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://kiosk.horizon-museum.org' },
    ],
  },
  {
    id: 'kiosk-entrance-2',
    osFamily: 'linux',
    osVersion: 'Ubuntu 24.04.3 LTS',
    online: true,
    cpuName: 'Intel Core i5-12400',
    cpuBase: 15, memBase: 38, memTotal: 16, diskBase: 54, diskTotal: 512,
    network: { latencyMs: 11, packetLoss: 0, txBps: 450000, rxBps: 2800000, txUtil: 3, rxUtil: 7, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'Chromium', status: 'RUNNING', pid: 3320, autolaunch: true, launch_mode: 'scheduled', exe_path: '/snap/bin/chromium', file_path: '--kiosk https://kiosk.horizon-museum.org' },
    ],
  },
  {
    id: 'kiosk-gift-shop',
    osFamily: 'windows',
    osVersion: WIN_KIOSK,
    online: false, // Offline machine for realism
    cpuName: 'Intel Core i5-12400',
    cpuBase: 12, memBase: 35, memTotal: 16, diskBase: 54, diskTotal: 512,
    network: { latencyMs: 14, packetLoss: 0, txBps: 200000, rxBps: 1500000, txUtil: 2, rxUtil: 4, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'Chrome', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'scheduled', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '--kiosk https://kiosk.horizon-museum.org/gift-shop' },
    ],
  },
  {
    id: 'media-lab-mac',
    osFamily: 'macos',
    osVersion: MACOS_VERSION,
    online: true,
    cpuName: 'Apple M4 Max',
    cpuBase: 41, memBase: 62, memTotal: 64, diskBase: 47, diskTotal: 2000,
    gpu: { name: 'Apple M4 Max', usageBase: 70, vramTotal: 64, vramUsed: 22.5 },
    network: { latencyMs: 5, packetLoss: 0, txBps: 22000000, rxBps: 9000000, txUtil: 18, rxUtil: 9, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'TouchDesigner', status: 'RUNNING', pid: 2381, autolaunch: true, launch_mode: 'always', exe_path: '/Applications/TouchDesigner.app', file_path: '/Users/media/Projects/media-lab.toe' },
      { id: 'p2', name: 'Node.js', status: 'RUNNING', pid: 2390, autolaunch: true, launch_mode: 'always', exe_path: '/opt/homebrew/bin/node', file_path: '/Users/media/Projects/osc-bridge/index.js' },
    ],
  },
  {
    id: 'stage-left-media',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'AMD Ryzen 7 7700X',
    cpuBase: 38, memBase: 55, memTotal: 32, diskBase: 48, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 45, vramTotal: 8, vramUsed: 4.8 },
    network: { latencyMs: 6, packetLoss: 0, txBps: 18000000, rxBps: 8000000, txUtil: 15, rxUtil: 10, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'OBS Studio', status: 'RUNNING', pid: 5501, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p2', name: 'VLC', status: 'RUNNING', pid: 6602, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: '' },
      { id: 'p3', name: 'Node.js', status: 'RUNNING', pid: 7703, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/show-control/server.js' },
    ],
  },
  {
    id: 'stage-right-media',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    rebooting: true, // Restarting machine for realism (field name is the wire contract)
    cpuName: 'AMD Ryzen 7 7700X',
    cpuBase: 35, memBase: 50, memTotal: 32, diskBase: 48, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 40, vramTotal: 8, vramUsed: 4.2 },
    network: { latencyMs: 7, packetLoss: 0, txBps: 16000000, rxBps: 7000000, txUtil: 13, rxUtil: 9, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    processes: [
      { id: 'p1', name: 'OBS Studio', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/obs-studio/bin/64bit/obs64.exe', file_path: '' },
      { id: 'p2', name: 'VLC', status: 'STOPPED', pid: null, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/VideoLAN/VLC/vlc.exe', file_path: '' },
    ],
  },
  {
    id: 'admin-workstation',
    osFamily: 'windows',
    osVersion: WIN_PRO,
    online: true,
    cpuName: 'Intel Core i7-13700',
    cpuBase: 22, memBase: 48, memTotal: 32, diskBase: 62, diskTotal: 1000,
    gpu: { name: 'NVIDIA RTX PRO 4000 (Blackwell)', usageBase: 18, vramTotal: 12, vramUsed: 3.2 },
    network: { latencyMs: 3, packetLoss: 0, txBps: 800000, rxBps: 5000000, txUtil: 5, rxUtil: 12, linkSpeed: 1000000000 },
    agentVersion: DEMO_RELEASE,
    rebootPending: {
      active: true,
      processName: 'Windows Update',
      reason: 'Pending system update requires restart',
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    },
    // its restart was sent inside active hours, so the machine holds it until they end
    rebootDeferredUntil: Math.ceil(Date.now() / 1000 / 3600 + 2) * 3600,
    processes: [
      { id: 'p1', name: 'Chrome', status: 'RUNNING', pid: 9012, autolaunch: false, launch_mode: 'off', exe_path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', file_path: '' },
      { id: 'p2', name: 'Node.js', status: 'RUNNING', pid: 1134, autolaunch: true, launch_mode: 'always', exe_path: 'C:/Program Files/nodejs/node.exe', file_path: 'C:/Projects/admin-panel/server.js' },
      { id: 'p3', name: 'TouchDesigner', status: 'STOPPED', pid: null, autolaunch: false, launch_mode: 'off', exe_path: 'C:/Program Files/Derivative/TouchDesigner/bin/TouchDesigner.exe', file_path: '' },
    ],
  },
];

function buildProcess(def: MachineDef['processes'][number], index: number): Process {
  return {
    ...def,
    schedules: null,
    schedulePresetId: null,
    cwd: '',
    priority: 'Normal',
    visibility: 'Normal',
    time_delay: '0',
    time_to_init: '10',
    relaunch_attempts: '3',
    responsive: def.status === 'RUNNING',
    last_updated: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 120),
    index,
  };
}

/**
 * Realistic HardwareProfile for a demo machine. Most get 2 disks + 2 NICs so
 * the dashboard's per-device dropdowns actually appear; kiosks get one of each.
 */
function buildProfile(def: MachineDef): HardwareProfile {
  const ids = deviceIds(def);
  const { fs } = OS_DEVICES[def.osFamily];
  const isThreadripper = def.cpuName.includes('Threadripper');
  const isHighCore = def.cpuName.includes('i9') || def.cpuName.includes('Ryzen 9');

  const cpus: CpuProfile[] = [{
    id: 'CPU0',
    model: def.cpuName,
    physicalCores: isThreadripper ? 32 : isHighCore ? 16 : 8,
    logicalCores: isThreadripper ? 64 : isHighCore ? 24 : 16,
    socketIndex: 0,
  }];

  // the system disk, then a media disk holding the larger share
  const disks: DiskProfile[] = ids.disks.length === 1
    ? [{ id: ids.disks[0], label: 'System', fs, totalGb: def.diskTotal }]
    : [
        { id: ids.disks[0], label: 'System', fs, totalGb: Math.round(def.diskTotal * 0.4) },
        { id: ids.disks[1], label: 'Media', fs, totalGb: Math.round(def.diskTotal * 0.6) },
      ];

  const gpus: GpuProfile[] = def.gpu
    ? [
        {
          id: 'GPU0',
          name: def.gpu.name,
          vramTotalGb: def.gpu.vramTotal,
          pciBus: '0000:01:00.0',
        },
        ...(def.extraGpus ?? []).map((g, i) => ({
          id: `GPU${i + 1}`,
          name: g.name,
          vramTotalGb: g.vramTotal,
          // sequential PCI bus addresses (0000:02:00.0, 0000:03:00.0, …)
          pciBus: `0000:${(i + 2).toString(16).padStart(2, '0')}:00.0`,
        })),
      ]
    : [];

  // wired, then wireless
  const nics: NicProfile[] = [
    { id: ids.nics[0], mac: '00:1A:2B:3C:4D:5E', linkSpeedMbps: 1000 },
    ...ids.nics.slice(1).map((id) => ({ id, mac: '00:1A:2B:3C:4D:5F', linkSpeedMbps: 866 })),
  ];

  return {
    schemaVersion: 2,
    signatureHash: `demo-${def.id}-profile-hash`,
    capturedAt: Date.now() - 30 * 24 * 3600 * 1000,
    agentVersion: def.agentVersion,
    cpus,
    disks,
    gpus,
    nics,
  };
}

/** Mirrors `joinMachineDevices` — the demo page calls `getDemoMachines()`
 *  directly, bypassing useMachines. */
function joinDevices(
  profile: HardwareProfile,
  metrics: NonNullable<Machine['metrics']>,
): NonNullable<Machine['devices']> {
  const buildBucket = <P extends { id: string }, M>(
    profileList: P[],
    metricMap: Record<string, M> | undefined,
  ): DeviceEntry<P, M>[] => {
    const result: DeviceEntry<P, M>[] = [];
    const seen = new Set<string>();
    for (const p of profileList) {
      const metric = metricMap?.[p.id];
      result.push({
        ...p,
        ...(metric ?? {}),
        isMissing: !metric,
        isOrphan: false,
      } as unknown as DeviceEntry<P, M>);
      seen.add(p.id);
    }
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

  return {
    cpus: buildBucket<CpuProfile, CpuMetric>(profile.cpus, metrics.cpus),
    disks: buildBucket<DiskProfile, DiskMetric>(profile.disks, metrics.disks),
    gpus: buildBucket<GpuProfile, GpuMetric>(profile.gpus, metrics.gpus),
    nics: buildBucket<NicProfile, NicMetric>(profile.nics, metrics.nics),
  };
}

/** every key of T, required, each keeping T's type: an optional one must still be named, if only as undefined */
type EveryField<T> = { [K in keyof Required<T>]: T[K] };

function buildMachine(def: MachineDef): Machine {
  const now = Math.floor(Date.now() / 1000);
  // an asleep mac last reported when it went to sleep, hours ago
  const heartbeatAge = def.asleep ? 3 * 3600 : def.online && !def.rebooting ? 15 + Math.floor(Math.random() * 30) : 300;

  const profile = buildProfile(def);
  const { disks: [systemDisk], nics: [wiredNic, wirelessNic] } = deviceIds(def);

  const cpus: Record<string, CpuMetric> = {
    CPU0: {
      percent: def.cpuBase + Math.floor(Math.random() * 8),
      temperature: def.cpuBase > 0 ? 42 + Math.floor(def.cpuBase * 0.4) : null,
    },
  };

  const disks: Record<string, DiskMetric> = {};
  for (const d of profile.disks) {
    // System disk tracks def.diskBase; data disk runs a bit lower.
    const pct = d.id === systemDisk ? def.diskBase : Math.max(5, def.diskBase - 12);
    disks[d.id] = {
      percent: pct,
      usedGb: +(d.totalGb * (pct / 100)).toFixed(0),
    };
  }

  // Plausible read/write rates so the cards' arrows and the disk-IO chart
  // aren't blank. Skipped when offline/restarting (panels show empty state).
  const diskio: NonNullable<Machine['metrics']>['diskio'] = {};
  if (def.online && !def.rebooting) {
    // Activity scales with cpu+gpu workload.
    const activity = (def.cpuBase + (def.gpu?.usageBase ?? 0)) / 100; // 0 - ~2
    for (const d of profile.disks) {
      // media disk: bulk reads; system disk: light reads + steady writes (logs, temp, swap).
      const isMedia = d.id !== systemDisk;
      const baseReadBps = isMedia ? 80_000_000 : 3_000_000;
      const baseWriteBps = isMedia ? 12_000_000 : 4_000_000;
      const readBps = Math.round(baseReadBps * activity * (0.7 + Math.random() * 0.6));
      const writeBps = Math.round(baseWriteBps * activity * (0.6 + Math.random() * 0.6));
      // Rough IOPS: large sequential reads → low IOPS; small writes → higher IOPS.
      const readIops = Math.max(1, Math.round(readBps / (isMedia ? 1_048_576 : 65_536)));
      const writeIops = Math.max(1, Math.round(writeBps / 16_384));
      // Busy% — saturate when activity is heavy on the media drive.
      const busyPct = Math.min(95, Math.round((isMedia ? 35 : 8) * activity + Math.random() * 8));
      diskio[d.id] = { readBps, writeBps, readIops, writeIops, busyPct };
    }
  }

  // Mirrors buildProfile (GPU0 primary, extraGpus → GPU1…). Every profiled GPU
  // needs a live metric or joinDevices tags it `isMissing`.
  const gpus: Record<string, GpuMetric> = {};
  if (def.gpu) {
    gpus.GPU0 = {
      usagePercent: def.gpu.usageBase + Math.floor(Math.random() * 8),
      vramUsedGb: def.gpu.vramUsed,
      temperature: 48 + Math.floor(def.gpu.usageBase * 0.35),
    };
    (def.extraGpus ?? []).forEach((g, i) => {
      gpus[`GPU${i + 1}`] = {
        usagePercent: g.usageBase + Math.floor(Math.random() * 8),
        vramUsedGb: g.vramUsed,
        temperature: 48 + Math.floor(g.usageBase * 0.35),
      };
    });
  }

  const nics: Record<string, NicMetric> = {};
  if (def.network) {
    // The wired NIC carries the bulk of traffic.
    nics[wiredNic] = {
      txBps: def.network.txBps,
      rxBps: def.network.rxBps,
      txUtil: def.network.txUtil,
      rxUtil: def.network.rxUtil,
    };
    // The wireless one (if profiled) carries light traffic.
    if (wirelessNic) {
      nics[wirelessNic] = {
        txBps: Math.round(def.network.txBps * 0.05),
        rxBps: Math.round(def.network.rxBps * 0.08),
        txUtil: +(def.network.txUtil * 0.1).toFixed(1),
        rxUtil: +(def.network.rxUtil * 0.1).toFixed(1),
      };
    }
  }

  const memory: MemoryMetric = {
    percent: def.memBase + Math.floor(Math.random() * 5),
    usedGb: +(def.memTotal * (def.memBase / 100)).toFixed(1),
  };

  const primary: PrimaryDevices = {
    cpu: 'CPU0',
    disk: systemDisk,
    gpu: def.gpu ? 'GPU0' : null,
    nic: def.network ? wiredNic : null,
  };

  const metrics: NonNullable<Machine['metrics']> = {
    schemaVersion: 2,
    profileHash: profile.signatureHash,
    timestamp: Date.now(),
    cpus,
    memory,
    disks,
    diskio,
    gpus,
    nics,
    network: def.network
      ? {
          latencyMs: def.network.latencyMs,
          packetLossPct: def.network.packetLoss,
          gatewayIp: '192.168.1.1',
        }
      : {},
    primary,
    processes: Object.fromEntries(
      def.processes.map(p => [p.name, p.status])
    ),
    // From displayTopologies so the card dot agrees with the panel (in prod the
    // agent computes this at heartbeat time).
    displayDriftCount: countDemoDrift(def.id),
  };

  // every field named, so one added to Machine fails tsc here until the demo
  // shows it or says why not. the machine menu, which most of the unset ones
  // feed, is hidden on /demo (`useDemoContext` in the machine views).
  const machine: EveryField<Machine> = {
    machineId: def.id,
    lastHeartbeat: now - heartbeatAge,
    online: def.online,
    asleep: def.asleep,
    agent_version: def.agentVersion,
    machineTimezone: DEMO_SITE.timezone,
    osFamily: def.osFamily,
    arch: OS_DEVICES[def.osFamily].arch,
    osVersion: def.osVersion,
    rebooting: def.rebooting,
    rebootPending: def.rebootPending,
    rebootDeferredUntil: def.rebootDeferredUntil,
    profile,
    metrics,
    devices: joinDevices(profile, metrics),
    processes: def.processes.map((p, i) => buildProcess(p, i)),
    // the machine menu's: swoop, hoot, restart and its active hours guard
    capabilities: undefined,
    activeHours: undefined,
    swoopViewers: undefined,
    rebootSchedule: undefined,
    // pages the demo does not have: hoot, the swoop picker, site settings, the screenshot dialog
    cortexEnabled: undefined,
    swoopSeats: undefined,
    displayAwake: undefined,
    lastScreenshot: undefined,
    // states the demo does not stage; stage-right-media restarts and admin-workstation holds one
    shuttingDown: undefined,
    rebootScheduledAt: undefined,
    shutdownScheduledAt: undefined,
    displayBreakerTripped: undefined,
    // the agent's own bookkeeping, never shown
    rebootState: undefined,
  };
  return machine;
}

/** Rebuilt on each call so heartbeats stay fresh */
export function getDemoMachines(): Machine[] {
  return machineDefs.map(buildMachine);
}

/** the header's site switcher counts, read by `useSiteMachineCounts` on /demo */
export const DEMO_SITE_MACHINE_COUNTS: Readonly<Record<string, number>> = { [DEMO_SITE_ID]: machineDefs.length };

/** a platform's installer through the public /download permalink, which serves the real latest one */
function permalink(os: string): InstallerFile {
  return {
    download_url: `${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/download?os=${os}`,
    checksum_sha256: null,
    file_size: null,
    file_name: null,
    uploaded_at: null,
  };
}

/** the latest installer the download buttons and the add machine dialog offer on /demo */
export const DEMO_LATEST_INSTALLER: Pick<InstallerVersionInfo, 'version' | 'files'> = {
  version: DEMO_RELEASE,
  files: { windows_x64: permalink('windows'), macos_arm64: permalink('macos'), linux_x64: permalink('linux') },
};

/** what generate code shows on /demo; no such code is ever created */
export const DEMO_PAIR_PHRASE = 'silver-compass-drift';

export interface DemoSparklineData {
  cpu: SparklineDataPoint[];
  memory: SparklineDataPoint[];
  disk: SparklineDataPoint[];
  gpu: SparklineDataPoint[];
  loading: boolean;
}

function generateSparkline(
  rand: () => number,
  base: number,
  amplitude: number,
  points: number = 60,
): SparklineDataPoint[] {
  const now = Math.floor(Date.now() / 1000);
  const result: SparklineDataPoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = now - (points - i) * 60; // 1-minute intervals
    const v = generateMetricValue(rand, base, amplitude, t, 24);
    result.push({ t, v: +v.toFixed(1) });
  }
  return result;
}

export function getDemoSparklineData(machineId: string): DemoSparklineData {
  const def = machineDefs.find(m => m.id === machineId);
  if (!def || !def.online || def.rebooting) {
    return { cpu: [], memory: [], disk: [], gpu: [], loading: false };
  }

  const seed = machineId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = seededRandom(seed);

  return {
    cpu: generateSparkline(rand, def.cpuBase, 12),
    memory: generateSparkline(rand, def.memBase, 6),
    disk: generateSparkline(rand, def.diskBase, 2),
    gpu: def.gpu ? generateSparkline(rand, def.gpu.usageBase, 15) : [],
    loading: false,
  };
}

const TIME_RANGE_DURATIONS: Record<TimeRange, number> = {
  '1h': 3600,
  '1d': 86400,
  '1w': 604800,
  '1m': 2592000,
  '1y': 31536000,
  'all': 31536000,
};

const TIME_RANGE_POINTS: Record<TimeRange, number> = {
  '1h': 60,
  '1d': 200,
  '1w': 300,
  '1m': 400,
  '1y': 500,
  'all': 500,
};

export function getDemoHistoricalData(
  machineId: string,
  timeRange: TimeRange,
): ChartDataPoint[] {
  const def = machineDefs.find(m => m.id === machineId);
  if (!def || !def.online) return [];

  const seed = machineId.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + timeRange.charCodeAt(0);
  const rand = seededRandom(seed);

  const duration = TIME_RANGE_DURATIONS[timeRange];
  const points = TIME_RANGE_POINTS[timeRange];
  const interval = duration / points;
  const now = Math.floor(Date.now() / 1000);

  // Must mirror buildProfile or historical chart keys won't line up with the
  // dropdowns sourced from `metrics.disks`/`gpus`.
  const { disks: diskIds, nics: [wiredNic] } = deviceIds(def);
  const [systemDisk] = diskIds;
  const gpuDefs = def.gpu
    ? [
        { id: 'GPU0', gpu: def.gpu },
        ...(def.extraGpus ?? []).map((g, i) => ({ id: `GPU${i + 1}`, gpu: g })),
      ]
    : [];

  // Bandwidth ceiling for `_io_*_pct` (mirrors the agent's hardware-class
  // estimate); system SSDs cap lower than the media NVMe.
  const diskMaxBps = (id: string) => (id === systemDisk ? 500_000_000 : 3_000_000_000);

  const data: ChartDataPoint[] = [];
  for (let i = 0; i < points; i++) {
    const t = now - duration + i * interval;

    // Daily pattern: higher during "open hours" (9am-6pm)
    const hourOfDay = ((t % 86400) / 3600 + 8) % 24; // offset for timezone
    const isOpenHours = hourOfDay >= 9 && hourOfDay <= 18;
    const dailyMultiplier = isOpenHours ? 1.0 : 0.4;

    const cpu = generateMetricValue(rand, def.cpuBase * dailyMultiplier, 10, t, 24);
    const memory = generateMetricValue(rand, def.memBase * (dailyMultiplier * 0.6 + 0.4), 5, t, 48);
    const disk = generateMetricValue(rand, def.diskBase, 1, t, 168);

    const point: ChartDataPoint = {
      time: t * 1000, // milliseconds for Recharts
      cpu: +cpu.toFixed(1),
      memory: +memory.toFixed(1),
      disk: +disk.toFixed(1),
    };

    // Mirrors buildMachine: system disk tracks def.diskBase, media runs lower.
    for (const id of diskIds) {
      const pct = id === systemDisk ? def.diskBase : Math.max(5, def.diskBase - 12);
      point[`${id}_pct`] = +generateMetricValue(rand, pct, 1, t, 168).toFixed(1);
    }

    for (const { id, gpu } of gpuDefs) {
      const usage = generateMetricValue(rand, gpu.usageBase * dailyMultiplier, 15, t, 24);
      point[`${id}_usage`] = +usage.toFixed(1);
      point[`${id}_temp`] = +(48 + usage * 0.32 + (rand() - 0.5) * 3).toFixed(1);
    }
    // Legacy single-GPU mirror — chart filters these out when {gpuId}_usage exists.
    if (def.gpu) {
      point.gpu = point['GPU0_usage'] as number;
      point.gpuTemp = point['GPU0_temp'] as number;
    }

    if (def.cpuBase > 0) {
      point.cpuTemp = +(42 + cpu * 0.35 + (rand() - 0.5) * 3).toFixed(1);
    }

    if (def.network) {
      const txUtil = generateMetricValue(rand, def.network.txUtil * dailyMultiplier, 8, t, 24);
      const rxUtil = generateMetricValue(rand, def.network.rxUtil * dailyMultiplier, 6, t, 24);
      point[`${wiredNic}_tx_util`] = +txUtil.toFixed(1);
      point[`${wiredNic}_rx_util`] = +rxUtil.toFixed(1);
      point[`${wiredNic}_tx`] = +(def.network.txBps * (txUtil / (def.network.txUtil || 1)) * dailyMultiplier).toFixed(0);
      point[`${wiredNic}_rx`] = +(def.network.rxBps * (rxUtil / (def.network.rxUtil || 1)) * dailyMultiplier).toFixed(0);
    }

    // Both bytes and %-of-max-bandwidth (plus busy%) so the detail panel can
    // flip modes exactly as it does for live data.
    const activity = (def.cpuBase + (def.gpu?.usageBase ?? 0)) / 100; // 0 - ~2
    for (const id of diskIds) {
      const isMedia = id !== systemDisk;
      const baseReadBps = isMedia ? 80_000_000 : 3_000_000;
      const baseWriteBps = isMedia ? 12_000_000 : 4_000_000;
      const readBps = Math.max(0, baseReadBps * activity * dailyMultiplier * (0.6 + rand() * 0.8));
      const writeBps = Math.max(0, baseWriteBps * activity * dailyMultiplier * (0.5 + rand() * 0.8));
      const maxBps = diskMaxBps(id);
      point[`${id}_io_read`] = Math.round(readBps);
      point[`${id}_io_write`] = Math.round(writeBps);
      point[`${id}_io_read_pct`] = +Math.min(100, (readBps / maxBps) * 100).toFixed(2);
      point[`${id}_io_write_pct`] = +Math.min(100, (writeBps / maxBps) * 100).toFixed(2);
      point[`${id}_io_busy`] = +Math.min(95, (isMedia ? 35 : 8) * activity * dailyMultiplier + rand() * 6).toFixed(1);
    }

    data.push(point);
  }

  return data;
}

/**
 * MonitorInfo with defaults. `id` is a Windows-style display path for realism;
 * `edidHash` is a stable fake from (machineId, slot) so live and assigned
 * monitors line up by identity.
 */
function makeMonitor(
  machineId: string,
  slot: number,
  override: Partial<MonitorInfo> & Pick<MonitorInfo, 'position' | 'resolution'>,
): MonitorInfo {
  const adapterLuid = `0x${(0x1000 + slot).toString(16)}`;
  const defaults: MonitorInfo = {
    id: `\\\\.\\DISPLAY${slot + 1}`,
    edidHash: `demo-${machineId}-edid-${slot}`,
    manufacturerId: 'DEL',
    productCode: '0xA1B2',
    serialNumber: `${machineId.toUpperCase()}-${slot + 1}`,
    friendlyName: `Display ${slot + 1}`,
    position: { x: 0, y: 0 },
    resolution: { width: 1920, height: 1080 },
    refreshHz: 60,
    rotation: 0,
    scalePct: 100,
    primary: slot === 0,
    connectionType: 'dp',
    adapterLuid,
    targetId: 0x10000 + slot,
  };
  return { ...defaults, ...override };
}

/**
 * Demo monitor topology per machine, built lazily (every collapsed card renders
 * the displays summary, so most subscribe).
 *
 * Deliberate coverage: some machines have an assigned layout and some don't, so
 * the panel demonstrates both states; `theater-projector` drifts (live 30Hz vs
 * assigned), which `countDemoDrift` turns into its card's drift dot. the macs and
 * the linux kiosk have none: display layouts are windows-only.
 */
const displayTopologies: Record<
  string,
  { live: MonitorInfo[]; assigned: MonitorInfo[] | null }
> = {
  'lobby-east-01': {
    live: [
      makeMonitor('lobby-east-01', 0, {
        friendlyName: 'lobby east',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: [
      makeMonitor('lobby-east-01', 0, {
        friendlyName: 'lobby east',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
  },
  'lobby-west-02': {
    live: [
      makeMonitor('lobby-west-02', 0, {
        friendlyName: 'lobby west',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: null, // not yet captured
  },
  'gallery-main': {
    live: [
      makeMonitor('gallery-main', 0, {
        friendlyName: 'left wall',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 1, {
        friendlyName: 'center wall',
        position: { x: 3840, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 2, {
        friendlyName: 'right wall',
        position: { x: 7680, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
    ],
    assigned: [
      makeMonitor('gallery-main', 0, {
        friendlyName: 'left wall',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 1, {
        friendlyName: 'center wall',
        position: { x: 3840, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
      makeMonitor('gallery-main', 2, {
        friendlyName: 'right wall',
        position: { x: 7680, y: 0 },
        resolution: { width: 3840, height: 2160 },
      }),
    ],
  },
  'theater-projector': {
    // Live: projector dropped to 30Hz after a power blip — drift vs assigned.
    live: [
      makeMonitor('theater-projector', 0, {
        friendlyName: 'main projector',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
        refreshHz: 30,
        connectionType: 'hdmi',
      }),
    ],
    assigned: [
      makeMonitor('theater-projector', 0, {
        friendlyName: 'main projector',
        position: { x: 0, y: 0 },
        resolution: { width: 3840, height: 2160 },
        refreshHz: 60,
        connectionType: 'hdmi',
      }),
    ],
  },
  'kiosk-entrance-1': {
    live: [
      makeMonitor('kiosk-entrance-1', 0, {
        friendlyName: 'entrance 1',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
    assigned: [
      makeMonitor('kiosk-entrance-1', 0, {
        friendlyName: 'entrance 1',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
  },
  'kiosk-gift-shop': {
    // Offline: last-known profile still shows so the card isn't empty.
    live: [
      makeMonitor('kiosk-gift-shop', 0, {
        friendlyName: 'gift shop',
        position: { x: 0, y: 0 },
        resolution: { width: 1080, height: 1920 },
        rotation: 90,
      }),
    ],
    assigned: null,
  },
  'stage-left-media': {
    live: [
      makeMonitor('stage-left-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-left-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: [
      makeMonitor('stage-left-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-left-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
  },
  'stage-right-media': {
    // Restarting — leave the last-known profile so the panel isn't blank.
    live: [
      makeMonitor('stage-right-media', 0, {
        friendlyName: 'preview',
        position: { x: 0, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
      makeMonitor('stage-right-media', 1, {
        friendlyName: 'program',
        position: { x: 1920, y: 0 },
        resolution: { width: 1920, height: 1080 },
      }),
    ],
    assigned: null,
  },
  'admin-workstation': {
    live: [
      makeMonitor('admin-workstation', 0, {
        friendlyName: 'left desk',
        position: { x: 0, y: 0 },
        resolution: { width: 2560, height: 1440 },
      }),
      makeMonitor('admin-workstation', 1, {
        friendlyName: 'right desk',
        position: { x: 2560, y: 0 },
        resolution: { width: 2560, height: 1440 },
      }),
    ],
    assigned: null,
  },
};

export interface DemoDisplayState {
  profile: DisplayProfile | null;
  assigned: AssignedLayout | null;
}

export function getDemoDisplayState(machineId: string): DemoDisplayState {
  const topology = displayTopologies[machineId];
  if (!topology) return { profile: null, assigned: null };

  const profile: DisplayProfile = {
    schemaVersion: 1,
    signatureHash: `demo-${machineId}-sig`,
    capturedAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    monitors: topology.live,
    mosaicActive: false,
  };

  const assigned: AssignedLayout | null = topology.assigned
    ? {
        monitors: topology.assigned,
        capturedAt: Date.now() - 7 * 24 * 3600 * 1000, // 1 week ago
        capturedBy: 'demo@owlette.app',
      }
    : null;

  return { profile, assigned };
}

/**
 * Match-by-edidHash drift count, same shape as the agent's
 * `metrics.displayDriftCount`. Drifted = any of
 * position/resolution/refreshHz/rotation/scalePct/primary differs. 0 when there
 * is no assigned layout.
 */
function countDemoDrift(machineId: string): number {
  const topology = displayTopologies[machineId];
  if (!topology || !topology.assigned) return 0;
  const assignedByHash = new Map<string, MonitorInfo>();
  for (const m of topology.assigned) {
    if (m.edidHash) assignedByHash.set(m.edidHash, m);
  }
  let drifted = 0;
  for (const live of topology.live) {
    const assigned = live.edidHash ? assignedByHash.get(live.edidHash) : undefined;
    if (!assigned) continue;
    const changed =
      live.position.x !== assigned.position.x ||
      live.position.y !== assigned.position.y ||
      live.resolution.width !== assigned.resolution.width ||
      live.resolution.height !== assigned.resolution.height ||
      live.refreshHz !== assigned.refreshHz ||
      live.rotation !== assigned.rotation ||
      live.scalePct !== assigned.scalePct ||
      live.primary !== assigned.primary;
    if (changed) drifted += 1;
  }
  return drifted;
}
