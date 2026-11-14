/**
 * Action core: machine-direct software uninstall.
 *
 * Writes an `uninstall_software` command into `sites/{siteId}/machines/{machineId}/commands/pending`
 * in the shape `buildUninstallCommand` gives both uninstall routes. Software metadata comes
 * server-side from the machine's `installed_software` collection.
 *
 * Capability `UNINSTALL_TRIGGER`, site-scoped via `authorizedSiteHandler`. Single-machine —
 * `/api/sites/{siteId}/deployments/{deploymentId}/uninstall` is the deployment fan-out variant.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { buildUninstallCommand } from '@/lib/actions/uninstallCommand.server';
import { TERMINAL_DEPLOYMENT_STATUSES } from '@/lib/deploymentStatuses';

export interface TriggerUninstallResult {
  siteId: string;
  machineId: string;
  software_name: string;
  commandId: string;
  status: 'pending';
  /** Set only when the command was tied to that deployment's target. */
  deployment_id?: string;
}

export type TriggerUninstallErrorCode =
  | 'validation_failed'
  | 'machine_not_found'
  | 'machine_offline'
  | 'software_not_found'
  | 'software_record_invalid';

export class TriggerUninstallError extends Error {
  readonly code: TriggerUninstallErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  constructor(
    code: TriggerUninstallErrorCode,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'TriggerUninstallError';
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

export interface TriggerUninstallInput {
  /** Display name of the software (must match a doc in `installed_software`). */
  software_name: string;
  /**
   * Exe names to terminate before uninstalling, forwarded verbatim. The current agent handler
   * ignores it; it is safe to send because the agent tolerates unknown fields.
   */
  close_processes?: string[];
  /** Overrides the agent's per-command timeout; clamped to [1s, 24h]. */
  timeout_seconds?: number;
  /** A deployment on this site that targets this machine; the reconciler then moves that target. */
  deployment_id?: string;
}

export interface TriggerUninstallOptions {
  /** Tests pass a mock. */
  db?: Firestore;
  /** Tests override for determinism. */
  now?: () => number;
  /** Audit correlation id from `authorizedSiteHandler`. */
  auditCorrelationId?: string;
  /**
   * Default false: queue even for offline machines (the agent picks the command up on reconnect),
   * matching the deployment-tied uninstall route. Set true for the generic commands route's gate.
   */
  requireOnline?: boolean;
}

const TIMEOUT_MIN_S = 1;
const TIMEOUT_MAX_S = 24 * 60 * 60; // matches the agent's longest job allowance
const SOFTWARE_NAME_MAX = 256;
const CLOSE_PROCESSES_MAX = 32;
// the shape createDeployment gives ids; anything else could address another document.
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Throws `TriggerUninstallError(validation_failed)` so the route can render RFC 7807. */
export function parseTriggerUninstallInput(raw: unknown): TriggerUninstallInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TriggerUninstallError(
      'validation_failed',
      'request body must be a json object',
      { body: ['must be a json object'] },
    );
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.software_name !== 'string') {
    throw new TriggerUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  const softwareName = body.software_name.trim();
  if (softwareName.length === 0) {
    throw new TriggerUninstallError(
      'validation_failed',
      'field `software_name` is required and must be a non-empty string',
      { 'body.software_name': ['required non-empty string'] },
    );
  }
  if (softwareName.length > SOFTWARE_NAME_MAX) {
    throw new TriggerUninstallError(
      'validation_failed',
      `field \`software_name\` exceeds ${SOFTWARE_NAME_MAX} characters`,
      { 'body.software_name': [`max ${SOFTWARE_NAME_MAX} chars`] },
    );
  }

  let closeProcesses: string[] | undefined;
  if (body.close_processes !== undefined && body.close_processes !== null) {
    if (!Array.isArray(body.close_processes)) {
      throw new TriggerUninstallError(
        'validation_failed',
        'field `close_processes` must be an array of strings when provided',
        { 'body.close_processes': ['must be an array of strings'] },
      );
    }
    if (body.close_processes.length > CLOSE_PROCESSES_MAX) {
      throw new TriggerUninstallError(
        'validation_failed',
        `field \`close_processes\` exceeds ${CLOSE_PROCESSES_MAX} entries`,
        { 'body.close_processes': [`max ${CLOSE_PROCESSES_MAX} entries`] },
      );
    }
    const cleaned: string[] = [];
    for (const entry of body.close_processes) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new TriggerUninstallError(
          'validation_failed',
          'field `close_processes` must be an array of non-empty strings',
          { 'body.close_processes': ['entries must be non-empty strings'] },
        );
      }
      cleaned.push(entry.trim());
    }
    closeProcesses = cleaned;
  }

  let timeoutSeconds: number | undefined;
  if (body.timeout_seconds !== undefined && body.timeout_seconds !== null) {
    const n = Number(body.timeout_seconds);
    if (!Number.isFinite(n) || n <= 0) {
      throw new TriggerUninstallError(
        'validation_failed',
        'field `timeout_seconds` must be a positive number when provided',
        { 'body.timeout_seconds': ['must be > 0'] },
      );
    }
    timeoutSeconds = Math.min(Math.max(Math.floor(n), TIMEOUT_MIN_S), TIMEOUT_MAX_S);
  }

  let deploymentId: string | undefined;
  if (body.deployment_id !== undefined && body.deployment_id !== null) {
    if (typeof body.deployment_id !== 'string' || !DEPLOYMENT_ID_PATTERN.test(body.deployment_id)) {
      throw new TriggerUninstallError(
        'validation_failed',
        'field `deployment_id` must be a deployment id when provided',
        { 'body.deployment_id': ['must be a deployment id'] },
      );
    }
    deploymentId = body.deployment_id;
  }

  const out: TriggerUninstallInput = { software_name: softwareName };
  if (closeProcesses !== undefined) out.close_processes = closeProcesses;
  if (timeoutSeconds !== undefined) out.timeout_seconds = timeoutSeconds;
  if (deploymentId !== undefined) out.deployment_id = deploymentId;
  return out;
}

/**
 * The deployment the command is tied to, or `undefined` to queue it untied. Looked up on this site
 * only, so a deployment on another site reads exactly like one that does not exist (refused). A
 * machine the deployment does not target is queued untied, as before deployment_id was read: a
 * dashboard loaded before then sends the id for every machine selected in the dialog.
 */
async function resolveDeploymentTie(
  db: Firestore,
  siteId: string,
  machineId: string,
  deploymentId: string,
): Promise<string | undefined> {
  const snap = await db
    .collection('sites')
    .doc(siteId)
    .collection('deployments')
    .doc(deploymentId)
    .get();
  if (!snap.exists) {
    throw new TriggerUninstallError(
      'validation_failed',
      `deployment ${deploymentId} not found on site ${siteId}`,
      { 'body.deployment_id': ['must name a deployment on this site'] },
    );
  }
  const targets = snap.data()?.targets;
  const target = Array.isArray(targets)
    ? (targets as Array<{ machineId?: unknown; status?: unknown } | null>).find(
        (t) => t?.machineId === machineId,
      )
    : undefined;
  if (!target) return undefined;
  // an install still queued or running could land after the uninstall and undo it.
  if (typeof target.status !== 'string' || !TERMINAL_DEPLOYMENT_STATUSES.has(target.status)) {
    throw new TriggerUninstallError(
      'validation_failed',
      `deployment ${deploymentId} is still ${String(target.status)} on machine ${machineId}; ` +
        `uninstall once its install has finished`,
      { 'body.deployment_id': ['its target for this machine has not finished installing'] },
    );
  }
  return deploymentId;
}

/** Writes one `uninstall_software` command into the machine's `commands/pending` map. */
export async function triggerUninstall(
  siteId: string,
  machineId: string,
  input: TriggerUninstallInput,
  options: TriggerUninstallOptions = {},
): Promise<TriggerUninstallResult> {
  if (!siteId) throw new TriggerUninstallError('validation_failed', 'siteId is required');
  if (!machineId) throw new TriggerUninstallError('validation_failed', 'machineId is required');

  const db = options.db ?? getAdminDb();
  const now = options.now ? options.now() : Date.now();

  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new TriggerUninstallError(
      'machine_not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }
  if (options.requireOnline) {
    const machineData = machineSnap.data() ?? {};
    if (machineData.online === false) {
      throw new TriggerUninstallError(
        'machine_offline',
        `machine ${machineId} is currently offline; uninstall cannot be queued ` +
          `until it reconnects`,
      );
    }
  }

  const deploymentId =
    input.deployment_id === undefined
      ? undefined
      : await resolveDeploymentTie(db, siteId, machineId, input.deployment_id);

  const built = await buildUninstallCommand(db, siteId, machineId, input.software_name, {
    closeProcesses: input.close_processes,
    timeoutSeconds: input.timeout_seconds,
    deploymentId,
    auditCorrelationId: options.auditCorrelationId,
    now,
  });
  if (!built.ok) throw new TriggerUninstallError(built.reason, built.message);

  const pendingRef = machineRef.collection('commands').doc('pending');
  await pendingRef.set({ [built.commandId]: built.command }, { merge: true });

  return {
    siteId,
    machineId,
    software_name: input.software_name,
    commandId: built.commandId,
    status: 'pending',
    ...(deploymentId ? { deployment_id: deploymentId } : {}),
  };
}
