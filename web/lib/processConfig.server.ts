/**
 * Transactional mutation of the process array at
 * `config/{siteId}/machines/{machineId}`. Admin-SDK transactions here, unlike the
 * client hooks in useFirestore.ts which read-modify-write non-transactionally.
 *
 * `withProcessLock` is the one writer: `processId`, lazy id backfill, rejects
 * duplicate names inside the transaction.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import crypto from 'crypto';

export interface ProcessConfig {
  /** Legacy id — kept for the dashboard hooks. */
  id: string;
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
  launch_mode: 'off' | 'always' | 'scheduled';
  schedules?: ScheduleBlock[] | null;
  schedulePresetId?: string | null;
  schedule?: { mode: 'off' | 'always' | 'scheduled'; blocks?: ScheduleBlock[] } | null;
  index?: number;
  /** Public-API id — same UUID as `id`. */
  processId?: string;
  [key: string]: unknown;
}

export interface ScheduleBlock {
  name?: string;
  colorIndex?: number;
  days: string[];
  ranges: { start: string; stop: string }[];
}

/** Strip undefined values and clean schedule blocks for Firestore. */
function cleanProcessForFirestore(process: ProcessConfig): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(process)) {
    if (value === undefined) continue;

    if (key === 'schedules' && Array.isArray(value)) {
      cleaned.schedules = value.map((block: ScheduleBlock) => {
        const cleanBlock: Record<string, unknown> = { days: block.days, ranges: block.ranges };
        if (block.name) cleanBlock.name = block.name;
        if (block.colorIndex != null) cleanBlock.colorIndex = block.colorIndex;
        return cleanBlock;
      });
    } else {
      cleaned[key] = value;
    }
  }

  return cleaned;
}

export class ProcessConfigError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Public-API view of a process row: `processId` (server-generated UUID) is the
 * canonical id. Legacy `id` is held in lockstep with the same value because the
 * agent and the admin route still read it.
 */
export interface PublicProcessConfig extends ProcessConfig {
  processId: string;
}

/**
 * Transactional read-modify-write of `processes[]`: lazily backfills `processId`,
 * runs the mutator, then rejects newly-introduced duplicate names — the check is
 * inside the txn, which is what makes it race-safe. Pre-existing duplicates
 * (agent-synced configs never validated names) do not block unrelated saves.
 * Sets `configChangeFlag` to nudge the agent.
 *
 * @throws ProcessConfigError 409 'duplicate_process_name', or 404 if no config doc.
 */
export async function withProcessLock<T>(
  siteId: string,
  machineId: string,
  fn: (processes: PublicProcessConfig[]) => { processes: PublicProcessConfig[]; result: T }
): Promise<T> {
  const db = getAdminDb();
  const configRef = db.collection('config').doc(siteId).collection('machines').doc(machineId);

  const result = await db.runTransaction(async (transaction) => {
    const configSnap = await transaction.get(configRef);

    if (!configSnap.exists) {
      throw new ProcessConfigError(404, 'Configuration not found for this machine');
    }

    const config = configSnap.data()!;
    if (!config.processes || !Array.isArray(config.processes)) {
      throw new ProcessConfigError(500, 'Invalid configuration structure — no processes array');
    }

    // Lazy backfill of `processId`.
    const normalized = (config.processes as ProcessConfig[]).map((p) => normalizeProcess(p));

    // Snapshot before the mutator runs — it may rename entries in place.
    const namesBefore = normalized.map((p) => p.name);

    const mutationResult = fn(normalized);

    // Inside the txn, so the duplicate check is race-safe.
    assertNoNewDuplicateNames(
      namesBefore,
      mutationResult.processes.map((p) => p.name)
    );

    const cleaned = mutationResult.processes.map(cleanProcessForFirestore);

    transaction.update(configRef, { processes: cleaned });

    return mutationResult.result;
  });

  // Non-critical: the agent polls on its own cycle.
  try {
    const statusRef = db.collection('sites').doc(siteId).collection('machines').doc(machineId);
    await statusRef.update({ configChangeFlag: true });
  } catch {
    // Ignore — agent polls config on its own cycle.
  }

  return result;
}

/**
 * Config-side process list with lazy `processId` backfill (GET list + detail).
 * Null when the machine has no config doc yet.
 */
export async function readProcessList(
  siteId: string,
  machineId: string
): Promise<PublicProcessConfig[] | null> {
  const db = getAdminDb();
  const configRef = db.collection('config').doc(siteId).collection('machines').doc(machineId);
  const snap = await configRef.get();

  if (!snap.exists) return null;
  const data = snap.data();
  if (!data?.processes || !Array.isArray(data.processes)) return [];

  const normalized = (data.processes as ProcessConfig[]).map((p) => normalizeProcess(p));

  // Persist the backfill if anything changed (best-effort, non-blocking).
  const needsWrite = normalized.some((n, i) => {
    const orig = data.processes[i] as ProcessConfig;
    return !orig.processId && n.processId;
  });
  if (needsWrite) {
    const cleaned = normalized.map(cleanProcessForFirestore);
    configRef.update({ processes: cleaned }).catch(() => {});
  }

  return normalized;
}

/** New server-side processId; centralized so every create path matches. */
export function generateProcessId(): string {
  return crypto.randomUUID();
}

/** Ensure `processId` exists and mirrors the legacy `id`. Idempotent. */
function normalizeProcess(p: ProcessConfig): PublicProcessConfig {
  const processId = p.processId || p.id || generateProcessId();
  return {
    ...p,
    id: processId,
    processId,
  };
}

/**
 * Throws 409 'duplicate_process_name' when a mutation introduces — or worsens —
 * a repeated `name`. Case-sensitive, to match agent behaviour.
 *
 * Collisions that already existed before the mutation are tolerated: the agent
 * side never validated names, so synced configs can arrive with duplicates
 * already in them, and rejecting the whole array would brick every subsequent
 * save on the machine — including the rename that would clean them up.
 */
export function assertNoNewDuplicateNames(
  namesBefore: Array<string | undefined>,
  namesAfter: Array<string | undefined>
): void {
  const before = new Map<string, number>();
  for (const name of namesBefore) {
    if (!name) continue;
    before.set(name, (before.get(name) ?? 0) + 1);
  }
  const after = new Map<string, number>();
  for (const name of namesAfter) {
    if (!name) continue;
    after.set(name, (after.get(name) ?? 0) + 1);
  }
  for (const [name, count] of after) {
    if (count > 1 && count > (before.get(name) ?? 0)) {
      throw new ProcessConfigError(
        409,
        `Duplicate process name: ${name}`,
        'duplicate_process_name'
      );
    }
  }
}

/**
 * Index of a process by public-API id, or -1. Matches on `processId` only —
 * legacy `id`-only rows are normalized by `withProcessLock` before lookup.
 */
export function findProcessIndex(
  processes: PublicProcessConfig[],
  processId: string
): number {
  return processes.findIndex((p) => p.processId === processId);
}
