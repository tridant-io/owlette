/**
 * hoot mcp's deployment tools: read a site's deployments and software presets,
 * create and cancel a deployment, and update the owlette agent on a machine.
 */

import { cancelDeployment } from '@/lib/actions/cancelDeployment.server';
import { createDeployment, type CreateDeploymentInput } from '@/lib/actions/createDeployment.server';
import { machineAuditActor } from '@/lib/actions/auditActor.server';
import { executeMachineCommand, ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { PRE_FLIGHT_DEPLOYMENT_STATUSES } from '@/lib/deploymentStatuses';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { executeServerSideTool } from '@/lib/hoot-utils.server';
import { INSTALLER_PLATFORMS, PLATFORM_LABEL } from '@/lib/installerPlatform';
import { loadLatestInstaller } from '@/lib/latestInstaller.server';
import { PLAN_REQUIRED_DETAIL, requireEntitlement } from '@/lib/plan.server';
import { grantCovers } from '@/lib/fleet/policy.server';
import type { FleetAnswer, FleetContext, FleetServerTool } from '@/lib/fleet/context';

const LIST_TOOL = 'list_deployments';
const GET_TOOL = 'get_deployment';
const PRESETS_TOOL = 'list_software_presets';
const CREATE_TOOL = 'create_deployment';
const CANCEL_TOOL = 'cancel_deployment';
const UPDATE_TOOL = 'update_owlette_agent';

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
// a narrowed grant hides rows, so the list reads this many of the newest to still fill a page
const LIST_SCAN = 200;
const PRESETS_MAX = 100;
// deployment ids are `deploy-<epoch ms>`; this keeps a path or a wildcard out of a doc id
const DEPLOYMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function completed(result: unknown): FleetAnswer {
  return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function failed(error: string): FleetAnswer {
  return { status: 'failed', error };
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function targetsOf(data: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(data.targets) ? (data.targets as Array<Record<string, unknown>>) : [];
}

function machineIdsOf(data: Record<string, unknown>): string[] {
  return targetsOf(data)
    .map((target) => target.machineId)
    .filter((id): id is string => typeof id === 'string');
}

/** a deployment names its machines, so it is visible only when every one is inside the grant. */
function visibleToGrant(ctx: FleetContext, data: Record<string, unknown>): boolean {
  if (ctx.grant.machineIds === null) return true;
  const ids = machineIdsOf(data);
  return ids.length > 0 && ids.every((id) => grantCovers(ctx.grant, id));
}

// the dashboard's fields without the installer url, which the caller does not need
function serializeDeployment(id: string, data: Record<string, unknown>) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : 'Unnamed Deployment',
    installerName: typeof data.installer_name === 'string' ? data.installer_name : '',
    silentFlags: typeof data.silent_flags === 'string' ? data.silent_flags : '',
    status: typeof data.status === 'string' ? data.status : 'pending',
    createdAt: timestampToIso(data.createdAt),
    completedAt: timestampToIso(data.completedAt),
    targets: targetsOf(data).map((target) => ({
      machineId: target.machineId,
      status: target.status,
      ...(typeof target.error === 'string' ? { error: target.error } : {}),
    })),
  };
}

const listDeploymentsTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: LIST_TOOL,
    description: `List the site's software deployments, newest first, each with its id, name, installer, status (pending, in_progress, completed, failed, partial, cancelled or uninstalled) and the machines it targets with how each one's install is going (pending, closing_processes, downloading, installing, completed, failed with its error, cancelled or uninstalled). A deployment is listed only when every machine it targets is a machine you may act on, and the result says in \`leftOut\` how many of the newest were left out for that reason. Returns up to \`limit\` deployments (default ${LIST_DEFAULT_LIMIT}, at most ${LIST_MAX_LIMIT}); \`more\` is true when older ones were not looked at or did not fit.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many deployments to return, at most ${LIST_MAX_LIMIT}. Default ${LIST_DEFAULT_LIMIT}.`,
        },
      },
    },
  },
  async run(ctx, params) {
    const limit = boundedInt(params.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
    if (ctx.grant.machineIds !== null && ctx.grant.machineIds.length === 0) {
      return completed({ deployments: [], count: 0, leftOut: 0, more: false });
    }
    const snap = await ctx.db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('deployments')
      .orderBy('createdAt', 'desc')
      .limit(LIST_SCAN)
      .get();
    const visible = snap.docs.filter((doc) => visibleToGrant(ctx, doc.data() ?? {}));
    const deployments = visible.slice(0, limit).map((doc) => serializeDeployment(doc.id, doc.data() ?? {}));
    return completed({
      deployments,
      count: deployments.length,
      leftOut: snap.docs.length - visible.length,
      more: visible.length > limit || snap.docs.length === LIST_SCAN,
    });
  },
};

const getDeploymentTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: GET_TOOL,
    description: "Get one software deployment by id: its name, installer, status (pending, in_progress, completed, failed, partial, cancelled or uninstalled) and the machines it targets with how each one's install is going (pending, closing_processes, downloading, installing, completed, failed with its error, cancelled or uninstalled). A deployment that targets any machine you may not act on answers as not found.",
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'The deployment id, from list_deployments.' },
      },
      required: ['deployment_id'],
    },
  },
  async run(ctx, params) {
    const id = params.deployment_id;
    if (typeof id !== 'string' || !DEPLOYMENT_ID_RE.test(id)) return failed('deployment_id must be a deployment id');
    const notFound = failed(`deployment ${id} not found`);
    if (ctx.grant.machineIds !== null && ctx.grant.machineIds.length === 0) return notFound;
    const snap = await ctx.db.collection('sites').doc(ctx.siteId).collection('deployments').doc(id).get();
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || !visibleToGrant(ctx, data)) return notFound;
    return completed(serializeDeployment(id, data));
  },
};

// presets are one catalogue for every site, readable by any signed-in user (firestore.rules
// `system_presets`), with no machines in them, so a narrowed grant reads them whole
const presetsTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: PRESETS_TOOL,
    description: `List the software presets a deployment can install: each with its id, name, software name, category, installer name and url, silent flags, verify path and the processes to close. Use it to find the installer for create_deployment. The catalogue is the same for every site. Returns at most ${PRESETS_MAX} presets; \`truncated\` says when more matched, so narrow with the filters.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        software_name: {
          type: 'string',
          description: 'Only presets whose software name or name contains this text, case-insensitive. E.g. "TouchDesigner".',
        },
        category: {
          type: 'string',
          description: 'Only presets whose category contains this text, case-insensitive. E.g. "Media Server".',
        },
      },
    },
  },
  async run(ctx, params) {
    const filters: Record<string, unknown> = {};
    if (typeof params.software_name === 'string') filters.software_name = params.software_name;
    if (typeof params.category === 'string') filters.category = params.category;
    // the reader hoot's get_system_presets uses
    const result = (await executeServerSideTool(ctx.db, ctx.siteId, [], 'get_system_presets', filters, {
      machineActor: ctx.actor,
    })) as { presets: unknown[] };
    return completed({
      presets: result.presets.slice(0, PRESETS_MAX),
      count: Math.min(result.presets.length, PRESETS_MAX),
      truncated: result.presets.length > PRESETS_MAX,
    });
  },
};

const createDeploymentTool: FleetServerTool = {
  target: 'machines',
  definition: {
    name: CREATE_TOOL,
    description: "Install software on machines: creates a deployment that tells each named machine to download the installer, check it and run it silently. It returns the deployment's id as soon as the installs are queued, before any machine has started; follow it with get_deployment, since each machine reports its own result. Find installers and flags with list_software_presets. The installer url must be https, one call names at most 50 machines, and a deployment is limited by the site's per-deployment machine quota. The agent's active-hours guard refuses an install inside a machine's active hours, and no call from a machine can override that, so that machine's install fails with an `active_hours` error.",
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A name for the deployment, shown in the dashboard.' },
        installer_name: { type: 'string', description: 'The installer file name, for example "TouchDesigner.exe".' },
        installer_url: { type: 'string', description: 'Where the machines download the installer. Must start with https://.' },
        silent_flags: { type: 'string', description: 'The installer\'s silent-install flags, for example "/S". An empty string for none.' },
        machines: {
          type: 'array',
          description: 'The ids of the machines to install on. Each must be a machine you may act on.',
          items: { type: 'string', description: 'A machine id.' },
        },
        verify_path: { type: 'string', description: 'A path on disk that must exist after the install for it to count as done.' },
        close_processes: {
          type: 'array',
          description: 'Executable names the agent closes before it installs.',
          items: { type: 'string', description: 'An executable name, for example "TouchDesigner.exe".' },
        },
        suppress_projects: {
          type: 'array',
          description: 'Project names or paths the agent stops watching during the install.',
          items: { type: 'string', description: 'A project name or path.' },
        },
        sha256_checksum: { type: 'string', description: 'The installer\'s SHA-256 as 64 hex characters; the agent refuses a download that does not match.' },
        parallel_install: { type: 'boolean', description: 'True to let the installer run beside the agent\'s other tasks.' },
      },
      required: ['name', 'installer_name', 'installer_url', 'silent_flags', 'machines'],
    },
  },
  async machines(_ctx, params) {
    const named = params.machines;
    if (!Array.isArray(named) || named.length === 0 || named.some((id) => typeof id !== 'string' || id.length === 0)) {
      return { error: 'machines must list at least one machine id' };
    }
    return { machines: named as string[] };
  },
  async run(ctx, machines, params) {
    // the route's plan gate is not in the core, so a machine's call meets it here
    if (await requireEntitlement(ctx.siteId, 'owlette.deployments')) {
      return failed(PLAN_REQUIRED_DETAIL['owlette.deployments']);
    }
    const auditActor = machineAuditActor(ctx.machineId);
    const result = await createDeployment(
      {
        name: params.name,
        installer_name: params.installer_name,
        installer_url: params.installer_url,
        silent_flags: params.silent_flags,
        verify_path: params.verify_path,
        close_processes: params.close_processes,
        suppress_projects: params.suppress_projects,
        sha256_checksum: params.sha256_checksum,
        parallel_install: params.parallel_install,
        machines,
      } as CreateDeploymentInput,
      // a machine has no uid: the doc's createdBy names it the way the audit row does
      { siteId: ctx.siteId, createdBy: auditActor, actorIdentifier: auditActor, correlationId: ctx.correlationId },
    );
    if (!result.ok) return failed(result.message);
    return completed({
      deploymentId: result.deploymentId,
      status: result.status,
      machines: result.targets.map((target) => target.machineId),
    });
  },
};

const cancelDeploymentTool: FleetServerTool = {
  target: 'machines',
  definition: {
    name: CANCEL_TOOL,
    description: 'Cancel a software deployment: every machine whose install has not started yet (still pending, closing processes or downloading) has it removed and is told to stop. A machine already installing or finished is left alone. It is refused unless every machine it would cancel on is a machine you may act on, and at most 50 machines a call. Returns the machines it cancelled.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        deployment_id: { type: 'string', description: 'The deployment id, from list_deployments.' },
      },
      required: ['deployment_id'],
    },
  },
  async machines(ctx, params) {
    const id = params.deployment_id;
    if (typeof id !== 'string' || !DEPLOYMENT_ID_RE.test(id)) return { error: 'deployment_id must be a deployment id' };
    const snap = await ctx.db.collection('sites').doc(ctx.siteId).collection('deployments').doc(id).get();
    const data = snap.data() ?? {};
    // one that names a machine outside the grant answers as an unknown one does,
    // as get_deployment answers it: the call learns neither that it exists nor its machines
    if (!snap.exists || !visibleToGrant(ctx, data)) return { error: `deployment ${id} not found` };
    // the targets the core would cancel, by its own rule: one that is installing
    // or finished is not acted on, so its machine need not pass the checks
    const ids = [
      ...new Set(
        targetsOf(data)
          .filter((target) => typeof target.status === 'string' && PRE_FLIGHT_DEPLOYMENT_STATUSES.has(target.status))
          .map((target) => target.machineId)
          .filter((machineId): machineId is string => typeof machineId === 'string'),
      ),
    ];
    if (ids.length === 0) return { error: `deployment ${id} has no install left to cancel` };
    return { machines: ids };
  },
  async run(ctx, machines, params) {
    const result = await cancelDeployment({
      siteId: ctx.siteId,
      deploymentId: params.deployment_id as string,
      actorIdentifier: machineAuditActor(ctx.machineId),
      correlationId: ctx.correlationId,
      machines,
    });
    if (!result.ok) {
      if (result.code === 'write_failed') throw result.cause instanceof Error ? result.cause : new Error(String(result.cause));
      return failed(result.message);
    }
    return completed({ deploymentId: result.deploymentId, status: result.status, cancelled: result.machine_ids });
  },
};

const updateOwletteTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: UPDATE_TOOL,
    description: "Update the owlette agent on a machine to the latest release, sending it the installer for its own platform (windows, macos or linux) with its checksum, as the dashboard's update does. The machine must be online. Returns once the update is queued; the agent installs and restarts itself, so check its `agentVersion` with list_machines afterwards. The agent's active-hours guard holds back restarts, shutdowns and installs but not this update, and no call from a machine can override that guard.",
    tier: 3,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx, machine) {
    const latest = await loadLatestInstaller();
    if (!latest || Object.keys(latest.files).length === 0) return failed('no owlette installer has been uploaded yet');

    // as the dashboard picks it: an agent that reports neither is windows x64
    const snap = await ctx.db.collection('sites').doc(ctx.siteId).collection('machines').doc(machine).get();
    const data = snap.data() ?? {};
    const key = `${typeof data.osFamily === 'string' ? data.osFamily : 'windows'}_${typeof data.arch === 'string' ? data.arch : 'x64'}`;
    const platform = INSTALLER_PLATFORMS.find((candidate) => candidate === key);
    const file = platform ? latest.files[platform] : undefined;
    if (!file) {
      const label = platform ? PLATFORM_LABEL[platform] : key.replace('_', ' ');
      return failed(`no ${label} build in v${latest.version}`);
    }
    // the agent rejects an update without a checksum
    if (!file.checksum_sha256) return failed(`the v${latest.version} installer has no checksum; it must be re-uploaded`);

    try {
      const { commandId } = await executeMachineCommand(
        {
          siteId: ctx.siteId,
          machineId: machine,
          actor: ctx.actor,
          auditActor: machineAuditActor(ctx.machineId),
          correlationId: ctx.correlationId,
        },
        {
          type: 'update_owlette',
          payload: {
            installer_url: file.download_url,
            target_version: latest.version,
            checksum_sha256: file.checksum_sha256,
          },
          auditAttributes: { toolName: UPDATE_TOOL },
        },
        { db: ctx.db },
      );
      return completed({ machine, commandId, version: latest.version, status: 'queued' });
    } catch (error) {
      if (error instanceof ExecuteMachineCommandError) return failed(error.detail);
      throw error;
    }
  },
};

export const deploymentTools: readonly FleetServerTool[] = [
  listDeploymentsTool,
  getDeploymentTool,
  presetsTool,
  createDeploymentTool,
  cancelDeploymentTool,
  updateOwletteTool,
];
