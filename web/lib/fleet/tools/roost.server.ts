/**
 * hoot mcp's roost tools: read a site's roosts and a roost's versions, deploy a
 * version to machines and roll a roost back. "target" is roost's own word for a
 * machine a roost deploys to.
 */

import { machineAuditActor } from '@/lib/actions/auditActor.server';
import {
  deployMachineSet,
  deployRoost,
  loadDeployableRoost,
  RoostProblem,
} from '@/lib/actions/deployRoost.server';
import { readRollbackMachines, resolveRollbackTarget, rollbackRoost } from '@/lib/actions/rollbackRoost.server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { gateOrProceed } from '@/lib/roostKillSwitch';
import { grantCovers } from '@/lib/fleet/policy.server';
import type { FleetAnswer, FleetContext, FleetServerTool } from '@/lib/fleet/context';

const LIST_ROOSTS_TOOL = 'list_roosts';
const LIST_VERSIONS_TOOL = 'list_roost_versions';
const DEPLOY_TOOL = 'deploy_roost_version';
const ROLLBACK_TOOL = 'rollback_roost';

const ROOSTS_DEFAULT_LIMIT = 25;
const ROOSTS_MAX_LIMIT = 100;
// a narrowed grant hides rows, so the list reads this many of the newest to still fill a page
const ROOSTS_SCAN = 200;
const VERSIONS_DEFAULT_LIMIT = 20;
const VERSIONS_MAX_LIMIT = 100;
const ROOST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

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

function targetsOf(data: Record<string, unknown>): string[] {
  return Array.isArray(data.targets)
    ? (data.targets as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
}

/** a roost names its machines, so it is visible only when every one is inside the grant. */
function visibleToGrant(ctx: FleetContext, data: Record<string, unknown>): boolean {
  if (ctx.grant.machineIds === null) return true;
  const ids = targetsOf(data);
  return ids.length > 0 && ids.every((id) => grantCovers(ctx.grant, id));
}

function noMachinesInGrant(ctx: FleetContext): boolean {
  return ctx.grant.machineIds !== null && ctx.grant.machineIds.length === 0;
}

/** the kill switch the roost routes honour, so a machine's call does not skip it. */
async function roostDisabled(ctx: FleetContext): Promise<string | null> {
  const gated = await gateOrProceed(ctx.siteId, async (siteId) => {
    const snap = await ctx.db.collection('sites').doc(siteId).get();
    return snap.exists ? (snap.data() ?? null) : null;
  });
  if (!gated) return null;
  const body = (await gated.json()) as { detail?: string };
  return body.detail ?? 'roost is disabled for this site';
}

function actionContext(ctx: FleetContext) {
  return { siteId: ctx.siteId, auditActor: machineAuditActor(ctx.machineId) };
}

const listRoostsTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: LIST_ROOSTS_TOOL,
    description: `List the site's roosts (project folders owlette distributes to machines), newest first, each with its id, name, the machines it deploys to, its current version and when it last changed. A roost is listed only when every machine it deploys to is a machine you may act on, and the result says in \`leftOut\` how many of the newest were left out for that reason. Returns up to \`limit\` roosts (default ${ROOSTS_DEFAULT_LIMIT}, at most ${ROOSTS_MAX_LIMIT}); \`more\` is true when older ones were not looked at or did not fit.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: `How many roosts to return, at most ${ROOSTS_MAX_LIMIT}. Default ${ROOSTS_DEFAULT_LIMIT}.`,
        },
      },
    },
  },
  async run(ctx, params) {
    const limit = boundedInt(params.limit, ROOSTS_DEFAULT_LIMIT, ROOSTS_MAX_LIMIT);
    if (noMachinesInGrant(ctx)) return completed({ roosts: [], count: 0, leftOut: 0, more: false });
    const snap = await ctx.db
      .collection('sites')
      .doc(ctx.siteId)
      .collection('roosts')
      .orderBy('createdAt', 'desc')
      .limit(ROOSTS_SCAN)
      .get();
    // as the public roosts list route does, soft-deleted roosts are not listed
    const live = snap.docs.filter((doc) => !(doc.data() ?? {}).deletedAt);
    const visible = live.filter((doc) => visibleToGrant(ctx, doc.data() ?? {}));
    const roosts = visible.slice(0, limit).map((doc) => {
      const data = doc.data() ?? {};
      return {
        roostId: doc.id,
        name: typeof data.name === 'string' ? data.name : doc.id,
        targets: targetsOf(data),
        extractPath: typeof data.extractPath === 'string' ? data.extractPath : null,
        currentVersionId: data.currentVersionId ?? null,
        currentVersionNumber: typeof data.currentVersionNumber === 'number' ? data.currentVersionNumber : null,
        previousVersionId: data.previousVersionId ?? null,
        updatedAt: timestampToIso(data.updatedAt),
      };
    });
    return completed({
      roosts,
      count: roosts.length,
      leftOut: live.length - visible.length,
      more: visible.length > limit || snap.docs.length === ROOSTS_SCAN,
    });
  },
};

const listVersionsTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: LIST_VERSIONS_TOOL,
    description: `List the published versions of one roost, newest first, each with its id, number, description, size, file count and when it was published. Versions are immutable; pass an id or number to deploy_roost_version or rollback_roost. A roost that deploys to any machine you may not act on answers as not found. Returns up to \`limit\` versions (default ${VERSIONS_DEFAULT_LIMIT}, at most ${VERSIONS_MAX_LIMIT}); \`more\` is true when older ones were not returned.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        roost_id: { type: 'string', description: 'The roost id, from list_roosts.' },
        limit: {
          type: 'number',
          description: `How many versions to return, at most ${VERSIONS_MAX_LIMIT}. Default ${VERSIONS_DEFAULT_LIMIT}.`,
        },
      },
      required: ['roost_id'],
    },
  },
  async run(ctx, params) {
    const id = params.roost_id;
    if (typeof id !== 'string' || !ROOST_ID_RE.test(id)) return failed('roost_id must be a roost id');
    const limit = boundedInt(params.limit, VERSIONS_DEFAULT_LIMIT, VERSIONS_MAX_LIMIT);
    const notFound = failed(`roost ${id} not found`);
    if (noMachinesInGrant(ctx)) return notFound;
    const roostRef = ctx.db.collection('sites').doc(ctx.siteId).collection('roosts').doc(id);
    const roostSnap = await roostRef.get();
    const roost = roostSnap.exists ? (roostSnap.data() ?? {}) : null;
    if (!roost || roost.deletedAt || !visibleToGrant(ctx, roost)) return notFound;
    const snap = await roostRef.collection('versions').orderBy('createdAt', 'desc').limit(limit + 1).get();
    const versions = snap.docs.slice(0, limit).map((doc) => {
      const data = doc.data() ?? {};
      return {
        versionId: doc.id,
        versionNumber: typeof data.versionNumber === 'number' ? data.versionNumber : null,
        description: typeof data.description === 'string' ? data.description : null,
        createdAt: timestampToIso(data.createdAt),
        totalSize: data.totalSize ?? 0,
        totalFiles: data.totalFiles ?? 0,
        parentVersionId: data.parentVersionId ?? null,
      };
    });
    return completed({ roostId: id, versions, count: versions.length, more: snap.docs.length > limit });
  },
};

const deployTool: FleetServerTool = {
  target: 'machines',
  definition: {
    name: DEPLOY_TOOL,
    description: "Deploy a published version of a roost to machines: owlette tells the first wave of them (about a tenth, at least 1 and at most 50, in id order) to download the version's files into the roost's folder, and the rest follow once enough of that wave has succeeded. A deploy of a version that is still rolling out changes nothing and says so. It acts on every machine the roost deploys to unless you narrow it with `machines`, and each machine it would act on must be one you may act on, or the whole call is refused.",
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        roost_id: { type: 'string', description: 'The roost id, from list_roosts.' },
        version_id: { type: 'string', description: "The version id, from list_roost_versions. Default: the roost's current version." },
        machines: {
          type: 'array',
          description: 'Deploy to only these machine ids. Default: every machine the roost deploys to.',
          items: { type: 'string', description: 'A machine id.' },
        },
      },
      required: ['roost_id'],
    },
  },
  async machines(ctx, params) {
    const input = deployInput(params);
    if ('error' in input) return input;
    try {
      const { roost } = await loadDeployableRoost(ctx.db, ctx.siteId, input.roostId, input.versionId);
      const machines = deployMachineSet(roost, input.machines);
      if (machines.length === 0) return { error: 'this roost deploys to no machines, and the call named none' };
      return { machines };
    } catch (error) {
      if (error instanceof RoostProblem) return { error: error.details.detail ?? error.details.title };
      throw error;
    }
  },
  async run(ctx, machines, params) {
    const input = deployInput(params);
    if ('error' in input) return failed(input.error);
    const disabled = await roostDisabled(ctx);
    if (disabled) return failed(disabled);
    try {
      const result = await deployRoost(actionContext(ctx), {
        roostId: input.roostId,
        versionId: input.versionId,
        machines: input.machines,
        requestedBy: machineAuditActor(ctx.machineId),
        endpoint: `/api/roosts/${input.roostId}/deploy`,
        method: 'POST',
        approvedMachines: machines,
      });
      return completed(result.body);
    } catch (error) {
      if (error instanceof RoostProblem) return failed(error.details.detail ?? error.details.title);
      throw error;
    }
  },
};

const rollbackTool: FleetServerTool = {
  target: 'machines',
  definition: {
    name: ROLLBACK_TOOL,
    description: 'Roll a roost back to a version it already published: the roost points at that version again, and every machine the roost deploys to is told at once to download it, with no first wave. It always acts on every machine the roost deploys to, and each must be one you may act on, or the whole call is refused. Nothing is published and the version you leave stays available.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        roost_id: { type: 'string', description: 'The roost id, from list_roosts.' },
        target_version: {
          type: 'string',
          description: 'The version to roll back to: "previous", "first", a version id or a version number such as 3. Default: "previous".',
        },
      },
      required: ['roost_id'],
    },
  },
  async machines(ctx, params) {
    const input = rollbackInput(params);
    if ('error' in input) return input;
    try {
      const machines = await readRollbackMachines(ctx.db, ctx.siteId, input.roostId);
      await resolveRollbackTarget(ctx.siteId, input.roostId, input.targetVersion);
      if (machines.length === 0) return { error: 'this roost deploys to no machines' };
      return { machines };
    } catch (error) {
      if (error instanceof RoostProblem) return { error: error.details.detail ?? error.details.title };
      throw error;
    }
  },
  async run(ctx, machines, params) {
    const input = rollbackInput(params);
    if ('error' in input) return failed(input.error);
    const disabled = await roostDisabled(ctx);
    if (disabled) return failed(disabled);
    try {
      const result = await rollbackRoost(actionContext(ctx), {
        roostId: input.roostId,
        targetVersion: input.targetVersion,
        requestedBy: machineAuditActor(ctx.machineId),
        endpoint: `/api/roosts/${input.roostId}/rollback`,
        method: 'POST',
        approvedMachines: machines,
      });
      return completed(result);
    } catch (error) {
      if (error instanceof RoostProblem) return failed(error.details.detail ?? error.details.title);
      throw error;
    }
  },
};

function deployInput(
  params: Record<string, unknown>,
): { roostId: string; versionId?: string; machines?: string[] } | { error: string } {
  const roostId = params.roost_id;
  if (typeof roostId !== 'string' || !ROOST_ID_RE.test(roostId)) return { error: 'roost_id must be a roost id' };
  const versionId = params.version_id;
  if (versionId !== undefined && (typeof versionId !== 'string' || !ROOST_ID_RE.test(versionId))) {
    return { error: 'version_id must be a version id' };
  }
  const machines = params.machines;
  if (machines !== undefined) {
    if (!Array.isArray(machines) || machines.length === 0 || machines.some((m) => typeof m !== 'string' || m.length === 0)) {
      return { error: 'machines must be a non-empty list of machine ids' };
    }
  }
  return {
    roostId,
    ...(versionId !== undefined ? { versionId: versionId as string } : {}),
    ...(machines !== undefined ? { machines: [...new Set(machines as string[])] } : {}),
  };
}

function rollbackInput(
  params: Record<string, unknown>,
): { roostId: string; targetVersion?: string | number } | { error: string } {
  const roostId = params.roost_id;
  if (typeof roostId !== 'string' || !ROOST_ID_RE.test(roostId)) return { error: 'roost_id must be a roost id' };
  const target = params.target_version;
  if (target !== undefined && typeof target !== 'string' && typeof target !== 'number') {
    return { error: 'target_version must be a version id, a number, "previous" or "first"' };
  }
  return { roostId, ...(target !== undefined ? { targetVersion: target } : {}) };
}

export const roostTools: readonly FleetServerTool[] = [listRoostsTool, listVersionsTool, deployTool, rollbackTool];
