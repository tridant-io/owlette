/**
 * Process-config helpers — seeding, read-back and dashboard locators for the
 * specs that pin the web↔agent process contract.
 *
 * A machine's process list lives in TWO documents and both have to be seeded:
 *
 * - `config/{siteId}/machines/{machineId}.processes[]` — the array the agent
 *   consumes and the one every web mutation writes through `withProcessLock`
 *   (`web/lib/processConfig.server.ts`). Source of truth; this is what the
 *   round-trip specs assert.
 * - `sites/{siteId}/machines/{machineId}.metrics.processes{}` — the status-doc
 *   map, keyed by process id, that the agent republishes on every metrics
 *   upload and that the dashboard RENDERS from.
 *
 * `useFirestore`'s config listener overlays only `launch_mode` / `schedules` /
 * `schedulePresetId` onto the rendered rows; names, paths and timing fields
 * always come from the status doc. Nothing in E2E plays the agent, so a saved
 * web edit never changes what a row displays — specs keep driving the UI by the
 * SEEDED names and assert the config doc for the outcome.
 *
 * Wire note: `time_delay`, `time_to_init` and `relaunch_attempts` are STRINGS
 * on the wire (the agent coerces them with `float()`), and `visibility` is
 * `Normal` / `Hidden` — the agent still accepts legacy `Show` / `Hide` and
 * normalizes them (`agent/src/owlette_service.py`).
 */

import type { Locator, Page } from '@playwright/test';
import { getAdminDb } from './emulator';
import { seedMachine } from './seed';

export type LaunchMode = 'off' | 'always' | 'scheduled';

export interface WireScheduleBlock {
  days: string[];
  ranges: { start: string; stop: string }[];
  name?: string;
  colorIndex?: number;
}

/** One row of `config/{siteId}/machines/{machineId}.processes[]`. */
export interface WireProcess {
  /** Legacy id the agent and the dashboard both key on. */
  id: string;
  /** Public-API id; absent on agent-written rows until a web mutation backfills it. */
  processId?: string;
  name: string;
  exe_path: string;
  file_path: string;
  cwd: string;
  priority: string;
  visibility: string;
  time_delay: string;
  time_to_init: string;
  relaunch_attempts: string;
  autolaunch: boolean;
  launch_mode: LaunchMode;
  schedules?: WireScheduleBlock[] | null;
  schedulePresetId?: string | null;
  [key: string]: unknown;
}

/** Input for {@link seedMachineWithProcesses}; every field but `id`/`name` defaults. */
export interface SeedProcess {
  /** Config `processes[].id` AND the `metrics.processes` map key — they must match. */
  id: string;
  name: string;
  exe_path?: string;
  file_path?: string;
  cwd?: string;
  priority?: string;
  visibility?: string;
  time_delay?: string;
  time_to_init?: string;
  relaunch_attempts?: string;
  launch_mode?: LaunchMode;
  schedules?: WireScheduleBlock[] | null;
  /** Status-doc only — drives the badge and the run controls. */
  status?: string;
  /** Status-doc only. */
  pid?: number | null;
}

function withDefaults(process: SeedProcess) {
  const launchMode: LaunchMode = process.launch_mode ?? 'off';
  return {
    id: process.id,
    name: process.name,
    exe_path: process.exe_path ?? `C:\\seed\\${process.name}`,
    file_path: process.file_path ?? '',
    cwd: process.cwd ?? 'C:\\seed',
    priority: process.priority ?? 'Normal',
    visibility: process.visibility ?? 'Normal',
    time_delay: process.time_delay ?? '0',
    time_to_init: process.time_to_init ?? '10',
    relaunch_attempts: process.relaunch_attempts ?? '3',
    launch_mode: launchMode,
    autolaunch: launchMode !== 'off',
    schedules: process.schedules ?? null,
  };
}

/**
 * Seed a machine plus its process list on both surfaces. Overwrites on re-run:
 * `seedMachine` rewrites the whole status doc, and the two writes below replace
 * the metrics map and the config array wholesale.
 */
export async function seedMachineWithProcesses(
  siteId: string,
  machineId: string,
  processes: SeedProcess[],
): Promise<void> {
  // monitorCount 0 — these specs never open the display panel.
  await seedMachine(siteId, machineId, { monitorCount: 0 });

  const db = getAdminDb();
  const nowSec = Math.floor(Date.now() / 1000);

  const metricsProcesses: Record<string, unknown> = {};
  processes.forEach((process, index) => {
    // The map key is the id — the agent doesn't repeat it inside the entry.
    const { id, ...fields } = withDefaults(process);
    metricsProcesses[id] = {
      ...fields,
      status: process.status ?? 'INACTIVE',
      pid: process.pid ?? null,
      responsive: true,
      last_updated: nowSec,
      index,
    };
  });

  // update() with a dotted path replaces the whole nested map; a set(..., merge)
  // would deep-merge and leave rows from a previous seed behind.
  await db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .update({ 'metrics.processes': metricsProcesses });

  // Agent-written shape: legacy `id`, no `processId` — `withProcessLock`
  // backfills that on the first web mutation.
  await db
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .set({ processes: processes.map(withDefaults) }, { merge: true });
}

/** The config-doc process array — the document the agent consumes. */
export async function readConfigProcesses(
  siteId: string,
  machineId: string,
): Promise<WireProcess[]> {
  const snap = await getAdminDb()
    .collection('config')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();
  const processes = snap.data()?.processes;
  return Array.isArray(processes) ? (processes as WireProcess[]) : [];
}

/** Names in config order — the shape the duplicate-name gate reasons about. */
export function configProcessNames(processes: WireProcess[]): string[] {
  return processes.map((process) => process.name);
}

/** One row by its legacy id. Throws rather than returning undefined so a miss reads as a failure. */
export function configProcessById(processes: WireProcess[], id: string): WireProcess {
  const match = processes.find((process) => process.id === id);
  if (!match) {
    throw new Error(
      `No process ${id} in config (have: ${processes.map((p) => p.id).join(', ') || 'none'})`,
    );
  }
  return match;
}

/** One `metrics.processes[processId]` entry from the status doc. */
export async function readStatusProcess(
  siteId: string,
  machineId: string,
  processId: string,
): Promise<Record<string, unknown> | undefined> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();
  return snap.data()?.metrics?.processes?.[processId];
}

/**
 * `sites/{siteId}/machines/{machineId}.configChangeFlag`, set by every
 * `withProcessLock` write (`web/lib/processConfig.server.ts`).
 *
 * NOT a nudge to the agent, despite the name and the comments around its
 * writers. Nothing in `agent/` or `desktop/` reads it: the agent learns about a
 * config change only from its own adaptive poll of the config doc
 * (`firebase_client._config_listener_loop`), and while
 * `firestore_rest_client.listen_to_document` does return a `wake_event` that
 * would shorten that poll, both call sites discard it (`_thread, _wake, stop =`).
 *
 * It is a write-only API contract field — assert that a mutation set it, never
 * that setting it made the agent do anything.
 */
export async function readConfigChangeFlag(
  siteId: string,
  machineId: string,
): Promise<unknown> {
  const snap = await getAdminDb()
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .get();
  return snap.data()?.configChangeFlag;
}

/**
 * Pin the dashboard's starting context for a fixture user: the site it opens on
 * and the expanded-processes preference the card view needs to render process
 * rows. Both are seeded values elsewhere, but `sites[]` and `preferences` are
 * shared mutable fixture state — pinning here keeps these specs order-independent.
 */
export async function pinDashboardContext(uid: string, siteId: string): Promise<void> {
  await getAdminDb()
    .collection('users')
    .doc(uid)
    .set(
      { lastSiteId: siteId, preferences: { processesExpanded: true } },
      { merge: true },
    );
}

/** The dashboard card for one machine. Card view is the default view. */
export function machineCard(page: Page, machineId: string): Locator {
  return page.getByTestId('machine-card').filter({ hasText: machineId });
}

/**
 * One process row inside a machine card. Rows are the direct children of the
 * card's process group; the stats group above it carries the same `divide-y`
 * class, so the row is pinned by an exact-text match on the process name.
 * Names are not guaranteed unique (see the duplicate-name spec) — callers
 * disambiguate with `.first()` / `.nth()`.
 */
export function processRow(card: Locator, processName: string): Locator {
  return card
    .locator('div.divide-y > div')
    .filter({ has: card.page().getByText(processName, { exact: true }) });
}

/** The row's pencil button, named "edit <process>". */
export function processEditButton(row: Locator): Locator {
  return row.getByRole('button', { name: /^edit / });
}

/** Sonner toasts, scoped so app copy containing the same words can't match. */
export function toasts(page: Page): Locator {
  return page.locator('[data-sonner-toast]');
}
