/**
 * Shared core behind `POST /api/sites/{siteId}/deployments` and hoot's
 * `invokeAsSystem`, so both fan out installs identically.
 *
 * validate → quota-check `sites/{siteId}.deployQuota` → write the deployment
 * doc pending → fan out `install_software` → flip to in_progress → audit.
 *
 * Status reconciliation is NOT here: the `onCommandCompleted` cloud function
 * (functions/src/deploymentStatus.ts) owns it.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { fanOutToMachines } from '@/lib/fanOut.server';
import { emitMutation } from '@/lib/auditLogClient';
import { resolveActiveHoursOverride } from '@/lib/actions/executeMachineCommand.server';
import logger from '@/lib/logger';

/** default per-site target quota when `sites/{siteId}.deployQuota` is unset. */
export const DEFAULT_DEPLOYMENT_MAX_TARGETS = 100;

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

export interface CreateDeploymentInput {
  name: string;
  installer_name: string;
  /** signed download url — must be `https://`. */
  installer_url: string;
  /** e.g. `/SILENT /NORESTART`. */
  silent_flags: string;
  /** post-install verification path on disk. */
  verify_path?: string;
  /** exe names the agent closes before install. */
  close_processes?: string[];
  /** project names/paths the installer should suppress. */
  suppress_projects?: string[];
  /** 64-char hex sha-256 of the installer binary. */
  sha256_checksum?: string;
  /** allow the installer to run alongside other tasks. */
  parallel_install?: boolean;
  /** machine ids in this site; de-duplicated. */
  machines: string[];
  /** a person's approval to install inside each target's active hours. */
  active_hours_override?: { reason: string } | null;
}

export interface CreateDeploymentContext {
  siteId: string;
  /** Firebase uid; the legacy deployment doc shape expects it. */
  createdBy: string;
  /** `user:<uid>` or `apiKey:<keyId>` for audit events. */
  actorIdentifier: string;
  /** woven through audit + commands. */
  correlationId: string;
  /** Test overrides; production omits both. */
  db?: ReturnType<typeof getAdminDb>;
  now?: () => number;
}

export type CreateDeploymentResult =
  | {
      ok: true;
      deploymentId: string;
      siteId: string;
      status: 'in_progress';
      targets: Array<{ machineId: string; status: 'pending' }>;
    }
  | {
      ok: false;
      code:
        | 'invalid_name'
        | 'invalid_installer_name'
        | 'invalid_installer_url'
        | 'installer_url_not_https'
        | 'invalid_silent_flags'
        | 'invalid_verify_path'
        | 'invalid_close_processes'
        | 'invalid_suppress_projects'
        | 'invalid_sha256_checksum'
        | 'invalid_machines'
        | 'invalid_active_hours_override'
        | 'over_quota';
      message: string;
      details?: Record<string, unknown>;
    };

interface ValidatedInput {
  name: string;
  installerName: string;
  installerUrl: string;
  silentFlags: string;
  verifyPath?: string;
  closeProcesses?: string[];
  suppressProjects?: string[];
  sha256?: string;
  parallelInstall: boolean;
  machines: string[];
}

function validateInput(
  input: CreateDeploymentInput,
): ValidatedInput | { error: Extract<CreateDeploymentResult, { ok: false }> } {
  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_name',
        message: 'field `name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.installer_name !== 'string' || input.installer_name.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_name',
        message: 'field `installer_name` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.installer_url !== 'string' || input.installer_url.trim().length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_url',
        message: 'field `installer_url` is required and must be a non-empty string',
      },
    };
  }
  if (typeof input.silent_flags !== 'string') {
    return {
      error: {
        ok: false,
        code: 'invalid_silent_flags',
        message: 'field `silent_flags` is required and must be a string',
      },
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(input.installer_url);
  } catch {
    return {
      error: {
        ok: false,
        code: 'invalid_installer_url',
        message: 'installer_url must be a valid URL',
      },
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      error: {
        ok: false,
        code: 'installer_url_not_https',
        message: 'installer_url must use HTTPS protocol',
      },
    };
  }

  let verifyPath: string | undefined;
  if (input.verify_path !== undefined && input.verify_path !== null) {
    if (typeof input.verify_path !== 'string') {
      return {
        error: {
          ok: false,
          code: 'invalid_verify_path',
          message: 'verify_path must be a string when provided',
        },
      };
    }
    verifyPath = input.verify_path;
  }

  let closeProcesses: string[] | undefined;
  if (input.close_processes !== undefined && input.close_processes !== null) {
    if (
      !Array.isArray(input.close_processes) ||
      input.close_processes.some((p) => typeof p !== 'string' || p.length === 0)
    ) {
      return {
        error: {
          ok: false,
          code: 'invalid_close_processes',
          message: 'close_processes must be a non-empty array of non-empty strings when provided',
        },
      };
    }
    if (input.close_processes.length > 0) closeProcesses = [...input.close_processes];
  }

  let suppressProjects: string[] | undefined;
  if (input.suppress_projects !== undefined && input.suppress_projects !== null) {
    if (
      !Array.isArray(input.suppress_projects) ||
      input.suppress_projects.some((p) => typeof p !== 'string' || p.length === 0)
    ) {
      return {
        error: {
          ok: false,
          code: 'invalid_suppress_projects',
          message: 'suppress_projects must be a non-empty array of non-empty strings when provided',
        },
      };
    }
    if (input.suppress_projects.length > 0) suppressProjects = [...input.suppress_projects];
  }

  let sha256: string | undefined;
  if (input.sha256_checksum !== undefined && input.sha256_checksum !== null) {
    if (typeof input.sha256_checksum !== 'string' || !SHA256_HEX_RE.test(input.sha256_checksum)) {
      return {
        error: {
          ok: false,
          code: 'invalid_sha256_checksum',
          message: 'sha256_checksum must be a 64-character hex SHA-256 hash',
        },
      };
    }
    sha256 = input.sha256_checksum;
  }

  const parallelInstall = input.parallel_install === true;

  if (
    !Array.isArray(input.machines) ||
    input.machines.some((m) => typeof m !== 'string' || m.length === 0)
  ) {
    return {
      error: {
        ok: false,
        code: 'invalid_machines',
        message: 'field `machines` must be a non-empty array of machineId strings',
      },
    };
  }
  const machines = [...new Set(input.machines)];
  if (machines.length === 0) {
    return {
      error: {
        ok: false,
        code: 'invalid_machines',
        message: 'machines must not be empty',
      },
    };
  }

  return {
    name: input.name.trim(),
    installerName: input.installer_name.trim(),
    installerUrl: input.installer_url,
    silentFlags: input.silent_flags,
    verifyPath,
    closeProcesses,
    suppressProjects,
    sha256,
    parallelInstall,
    machines,
  };
}

/**
 * Create an installer deployment and fan out `install_software`.
 *
 * Doc + command payloads keep the legacy field names (`installer_url`,
 * `installer_name`, `silent_flags`, `deployment_id`) that shipped agents read.
 */
export async function createDeployment(
  input: CreateDeploymentInput,
  ctx: CreateDeploymentContext,
): Promise<CreateDeploymentResult> {
  const validated = validateInput(input);
  if ('error' in validated) return validated.error;

  const override = resolveActiveHoursOverride(input.active_hours_override, ctx.actorIdentifier);
  if (!override.ok) {
    return {
      ok: false,
      code: 'invalid_active_hours_override',
      message: `active_hours_override: ${override.error}`,
    };
  }
  const activeHoursOverride = override.override;

  const db = ctx.db ?? getAdminDb();
  const now = ctx.now ?? (() => Date.now());

  // Missing or invalid `deployQuota` falls back to the default.
  const siteSnap = await db.collection('sites').doc(ctx.siteId).get();
  const siteData = siteSnap.exists ? (siteSnap.data() ?? {}) : {};
  const quotaRaw = (siteData as Record<string, unknown>).deployQuota;
  const maxTargets =
    typeof quotaRaw === 'number' && Number.isFinite(quotaRaw) && quotaRaw > 0
      ? Math.floor(quotaRaw)
      : DEFAULT_DEPLOYMENT_MAX_TARGETS;

  if (validated.machines.length > maxTargets) {
    return {
      ok: false,
      code: 'over_quota',
      message: `requested ${validated.machines.length} target machines but max-targets-per-deploy on this site is ${maxTargets}`,
      details: { max_targets: maxTargets, requested: validated.machines.length },
    };
  }

  const deploymentId = `deploy-${now()}`;
  const deploymentRef = db
    .collection('sites')
    .doc(ctx.siteId)
    .collection('deployments')
    .doc(deploymentId);

  const targets = validated.machines.map((machineId) => ({
    machineId,
    status: 'pending' as const,
  }));

  const deploymentData: Record<string, unknown> = {
    name: validated.name,
    installer_name: validated.installerName,
    installer_url: validated.installerUrl,
    silent_flags: validated.silentFlags,
    targets,
    createdAt: FieldValue.serverTimestamp(),
    status: 'pending',
    createdBy: ctx.createdBy,
    auditCorrelationId: ctx.correlationId,
  };
  if (validated.sha256) deploymentData.sha256_checksum = validated.sha256;
  if (validated.verifyPath) deploymentData.verify_path = validated.verifyPath;
  if (validated.closeProcesses) deploymentData.close_processes = validated.closeProcesses;
  if (validated.suppressProjects) deploymentData.suppress_projects = validated.suppressProjects;
  if (validated.parallelInstall) deploymentData.parallel_install = true;

  await deploymentRef.set(deploymentData);

  // Underscore-prefixed command ids match the legacy hook shape, so the agent's
  // listener sees the same keys it always has.
  const sanitizedDeploymentId = deploymentId.replace(/-/g, '_');
  const commandIdPrefix = `install_${sanitizedDeploymentId}`;

  const fanOutResults = await fanOutToMachines({
    siteId: ctx.siteId,
    machineIds: validated.machines,
    correlationId: ctx.correlationId,
    db,
    now,
    builder: () => {
      const commandData: Record<string, unknown> = {
        type: 'install_software',
        installer_url: validated.installerUrl,
        installer_name: validated.installerName,
        silent_flags: validated.silentFlags,
        deployment_id: deploymentId,
        timestamp: FieldValue.serverTimestamp(),
        status: 'pending',
      };
      if (validated.sha256) commandData.sha256_checksum = validated.sha256;
      if (validated.verifyPath) commandData.verify_path = validated.verifyPath;
      if (validated.closeProcesses) commandData.close_processes = validated.closeProcesses;
      if (validated.suppressProjects) commandData.suppress_projects = validated.suppressProjects;
      if (validated.parallelInstall) commandData.parallel_install = true;
      if (activeHoursOverride) commandData.activeHoursOverride = activeHoursOverride;
      return { commandIdPrefix, commandData };
    },
  });
  const failedFanOut = fanOutResults.find((result) => !result.ok);
  if (failedFanOut) {
    throw new Error(
      `failed to fan out install_software command to ${failedFanOut.machineId}: ${failedFanOut.error ?? 'unknown error'}`,
    );
  }

  await deploymentRef.update({ status: 'in_progress' });

  try {
    emitMutation({
      kind: 'deployment_mutated',
      siteId: ctx.siteId,
      actor: ctx.actorIdentifier,
      targetId: deploymentId,
      attributes: {
        endpoint: `/api/sites/${ctx.siteId}/deployments`,
        method: 'POST',
        verb: 'create',
        target_count: validated.machines.length,
        installer_name: validated.installerName,
        correlationId: ctx.correlationId,
        ...(activeHoursOverride
          ? { activeHoursOverride: true, activeHoursOverrideReason: activeHoursOverride.reason }
          : {}),
      },
    });
  } catch (err) {
    // Fire-and-forget by design; this only catches a sync throw.
    logger.warn('[createDeployment] mutation emit threw synchronously', {
      context: 'createDeployment',
      data: { err: err instanceof Error ? err.message : String(err) },
    });
  }

  return {
    ok: true,
    deploymentId,
    siteId: ctx.siteId,
    status: 'in_progress',
    targets,
  };
}
