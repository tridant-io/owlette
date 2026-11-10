/**
 * The one `uninstall_software` command both uninstall routes queue: the machine
 * route for one machine, the deployment route for each of its targets. Every
 * agent from 3.3.x up runs this shape and refuses one without `software_name`
 * and `uninstall_command`, so both come from that machine's own
 * `installed_software` record, matched on the exact name the caller gives.
 * Never a fuzzy or prefix match: the agent runs the command silently as SYSTEM.
 */

import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { stampCommand, type StampedCommandData } from '@/lib/commandLifecycle';

export type UninstallCommandRefusal = 'software_not_found' | 'software_record_invalid';

export interface UninstallCommandOptions {
  /** Forwarded verbatim; the current agent handler ignores it. */
  closeProcesses?: string[];
  timeoutSeconds?: number;
  /** Ties the command to that deployment's target, so the reconciler moves it. */
  deploymentId?: string;
  auditCorrelationId?: string;
  now: number;
}

export type UninstallCommandResult<Refusal extends string = UninstallCommandRefusal> =
  | { ok: true; commandId: string; command: StampedCommandData }
  | { ok: false; reason: Refusal; message: string };

/**
 * Queried by the `name` field, not doc id — the agent derives ids from a registry-key fingerprint,
 * so they are not predictable. The agent lists each (name, version) once, so two versions under
 * one name are two records.
 */
async function findSoftwareRecords(
  db: Firestore,
  siteId: string,
  machineId: string,
  softwareName: string,
  limit: number,
): Promise<Array<Record<string, unknown> | undefined>> {
  const ref = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('installed_software');
  const snap = await ref.where('name', '==', softwareName).limit(limit).get();
  if (snap.empty) return [];
  return snap.docs.map((doc) => doc.data());
}

/**
 * Builds the command for one machine from the first record with that name; reads only, the caller
 * writes it. The machine route's, where a person picked the program in a dialog.
 */
export async function buildUninstallCommand(
  db: Firestore,
  siteId: string,
  machineId: string,
  softwareName: string,
  options: UninstallCommandOptions,
): Promise<UninstallCommandResult> {
  const [record] = await findSoftwareRecords(db, siteId, machineId, softwareName, 1);
  return commandFromRecord(record, machineId, softwareName, options);
}

/**
 * As `buildUninstallCommand`, but a name the machine lists more than once is refused, not
 * resolved to whichever record comes first: nobody picked a version on this path.
 */
export async function buildUniqueUninstallCommand(
  db: Firestore,
  siteId: string,
  machineId: string,
  softwareName: string,
  options: UninstallCommandOptions,
): Promise<UninstallCommandResult<UninstallCommandRefusal | 'software_ambiguous'>> {
  const records = await findSoftwareRecords(db, siteId, machineId, softwareName, 2);
  if (records.length > 1) {
    return {
      ok: false,
      reason: 'software_ambiguous',
      message: `machine ${machineId} lists more than one program named "${softwareName}"`,
    };
  }
  return commandFromRecord(records[0], machineId, softwareName, options);
}

function commandFromRecord(
  record: Record<string, unknown> | undefined,
  machineId: string,
  softwareName: string,
  options: UninstallCommandOptions,
): UninstallCommandResult {
  if (!record) {
    return {
      ok: false,
      reason: 'software_not_found',
      message: `software "${softwareName}" is not installed on machine ${machineId}`,
    };
  }
  const uninstallCommand = record.uninstall_command;
  if (typeof uninstallCommand !== 'string' || uninstallCommand.length === 0) {
    return {
      ok: false,
      reason: 'software_record_invalid',
      message:
        `software "${softwareName}" has no recorded uninstall command; ` +
        `cannot trigger uninstall`,
    };
  }
  const installerType =
    typeof record.installer_type === 'string' && record.installer_type.length > 0
      ? record.installer_type
      : 'custom';
  const installLocation =
    typeof record.install_location === 'string' && record.install_location.length > 0
      ? record.install_location
      : '';
  const verifyPaths = installLocation ? [installLocation] : [];

  // Bit-for-bit match against useUninstall.ts.
  const commandBody: Record<string, unknown> = {
    type: 'uninstall_software',
    software_name: softwareName,
    uninstall_command: uninstallCommand,
    installer_type: installerType,
    verify_paths: verifyPaths,
    timestamp: FieldValue.serverTimestamp(),
  };
  if (options.closeProcesses !== undefined) {
    commandBody.close_processes = options.closeProcesses;
  }
  if (options.timeoutSeconds !== undefined) {
    commandBody.timeout_seconds = options.timeoutSeconds;
  }
  if (options.deploymentId !== undefined) {
    commandBody.deployment_id = options.deploymentId;
  }

  return {
    ok: true,
    // The `uninstall-` prefix is load-bearing: dashboard listeners and the agent's command-id prefix
    // tracking both match on it.
    commandId: `uninstall-${options.now}`,
    command: stampCommand(commandBody, {
      auditCorrelationId: options.auditCorrelationId,
      now: () => options.now,
    }),
  };
}
