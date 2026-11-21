/**
 * Action core: deploy a roost version to machines. Moved out of
 * `POST /api/roosts/{roostId}/deploy` unchanged; the route keeps auth, the
 * kill-switch gate, idempotency and the response, and the fleet tool calls this
 * as the calling machine.
 */
import { Timestamp, FieldValue, type Firestore } from 'firebase-admin/firestore';
import { ProblemType, type ProblemDetails } from '@/lib/apiErrors';
import { emitMutation } from '@/lib/auditLogClient';
import { getAdminDb } from '@/lib/firebase-admin';
import type { ActionContext } from './createProcess.server';

/**
 * what the roost cores need. no actor: the routes check scope and membership
 * before they call, and dispatch has checked a machine's grant.
 */
export type RoostActionContext = Pick<ActionContext, 'siteId' | 'auditActor'>;

/**
 * a refusal that carries the whole problem body a route answers with, so the
 * route can rebuild the identical response and a tool can read the words.
 */
export class RoostProblem extends Error {
  readonly details: ProblemDetails;
  constructor(details: ProblemDetails) {
    super(details.detail ?? details.title);
    this.details = details;
  }
}

const DEFAULT_EXTRACT_ROOT = '~/Documents/Owlette';
const CANARY_FRACTION = 0.1;
const CANARY_MIN = 1;
const CANARY_MAX = 50;
// same pattern as validateResourceId in app/api/_shared.ts
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function validation(detail: string, errors: Record<string, string[]>): RoostProblem {
  return new RoostProblem({
    type: ProblemType.ValidationFailed,
    title: 'validation failed',
    status: 400,
    detail,
    errors,
  });
}

export interface DeployRoostInput {
  roostId: string;
  /** the request's fields as received: this core validates them. */
  versionId?: unknown;
  machines?: unknown;
  scheduleAt?: unknown;
  dryRun?: unknown;
  /** who is recorded as `triggeredBy` on the rollout: a user id, or `machine:<id>`. */
  requestedBy: string;
  /** audit attributes: the route passes its own path and method. */
  endpoint: string;
  method: string;
  /**
   * the machines a caller already checked. The deploy is refused if the
   * machines it would act on are not exactly this set.
   */
  approvedMachines?: readonly string[];
  db?: Firestore;
}

export interface DeployRoostResult {
  /** 'queued' is the only outcome a route saves for idempotency. */
  outcome: 'dry_run' | 'already_running' | 'queued';
  status: 200 | 202;
  body: Record<string, unknown>;
}

/** the machines a deploy acts on: the request's list, else the roost's own. */
export function deployMachineSet(
  roost: Record<string, unknown>,
  explicitMachines: readonly string[] | undefined,
): string[] {
  const roostTargets = Array.isArray(roost.targets) ? (roost.targets as string[]) : [];
  return [...(explicitMachines ?? roostTargets)];
}

export function sameMachineSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((m) => right.has(m));
}

/** the roost, the version to deploy and its url; throws RoostProblem for a missing or deleted one. */
export async function loadDeployableRoost(
  db: Firestore,
  siteId: string,
  roostId: string,
  explicitVersionId: string | undefined,
): Promise<{
  roostRef: FirebaseFirestore.DocumentReference;
  roost: Record<string, unknown>;
  versionId: string;
  versionUrl: string;
}> {
  const roostRef = db
    .collection('sites')
    .doc(siteId)
    .collection('roosts')
    .doc(roostId);
  const roostSnap = await roostRef.get();
  if (!roostSnap.exists) {
    throw new RoostProblem({
      type: ProblemType.NotFound,
      title: 'not found',
      status: 404,
      detail: `roost ${roostId} not found on site ${siteId}`,
      instance: `/api/roosts/${roostId}/deploy`,
    });
  }
  const roost = roostSnap.data() ?? {};
  if (roost.deletedAt) {
    throw new RoostProblem({
      type: ProblemType.Conflict,
      title: 'roost deleted',
      status: 409,
      detail: `roost ${roostId} is soft-deleted; undelete before deploying`,
      instance: `/api/roosts/${roostId}/deploy`,
    });
  }

  const versionId = explicitVersionId ?? (typeof roost.currentVersionId === 'string' ? roost.currentVersionId : null);
  if (!versionId) {
    throw validation(
      'versionId is required — roost has no currentVersionId to fall back on',
      { 'body.versionId': ['no current version; specify versionId explicitly'] },
    );
  }

  // roost.versionUrl is authoritative for the current version; otherwise read
  // versions/{id}.
  let versionUrl: string | null = null;
  if (versionId === roost.currentVersionId && typeof roost.versionUrl === 'string') {
    versionUrl = roost.versionUrl;
  } else {
    const versionSnap = await roostRef.collection('versions').doc(versionId).get();
    if (!versionSnap.exists) {
      throw new RoostProblem({
        type: ProblemType.NotFound,
        title: 'version not found',
        status: 404,
        detail: `version ${versionId} is not in this roost's history`,
        instance: `/api/roosts/${roostId}/deploy`,
        code: 'version_not_found',
      });
    }
    versionUrl = (versionSnap.data()?.versionUrl as string | undefined) ?? null;
  }
  if (!versionUrl) {
    throw new RoostProblem({
      type: ProblemType.Conflict,
      title: 'version has no url',
      status: 409,
      detail: 'the version pointer exists but its R2 url is missing; cannot fan out without it',
      instance: `/api/roosts/${roostId}/deploy`,
    });
  }
  return { roostRef, roost, versionId, versionUrl };
}

export async function deployRoost(
  ctx: RoostActionContext,
  input: DeployRoostInput,
): Promise<DeployRoostResult> {
  const { roostId } = input;
  const siteId = ctx.siteId;
  const dryRun = input.dryRun === true;

  let explicitVersionId: string | undefined;
  if (input.versionId !== undefined) {
    if (typeof input.versionId !== 'string') {
      throw validation('versionId must be a string when provided', {
        'body.versionId': ['must be a string'],
      });
    }
    if (!RESOURCE_ID_RE.test(input.versionId)) {
      throw validation('versionId must be 8-64 chars: letters, digits, underscore, hyphen', {
        versionId: ['invalid format'],
      });
    }
    explicitVersionId = input.versionId;
  }

  let explicitMachines: string[] | undefined;
  if (input.machines !== undefined) {
    if (!Array.isArray(input.machines) || input.machines.some((m) => typeof m !== 'string' || m.length === 0)) {
      throw validation('machines must be an array of non-empty machineId strings', {
        'body.machines': ['must be string[]'],
      });
    }
    explicitMachines = [...new Set(input.machines as string[])];
    if (explicitMachines.length === 0) {
      throw validation('machines must not be empty when provided', {
        'body.machines': ['must be non-empty when provided'],
      });
    }
  }

  let scheduleAtMs: number | undefined;
  if (input.scheduleAt !== undefined) {
    if (typeof input.scheduleAt !== 'string') {
      throw validation('scheduleAt must be an ISO-8601 string when provided', {
        'body.scheduleAt': ['must be iso8601 string'],
      });
    }
    const parsedAt = Date.parse(input.scheduleAt);
    if (Number.isNaN(parsedAt)) {
      throw validation('scheduleAt could not be parsed as ISO-8601', {
        'body.scheduleAt': ['invalid iso8601'],
      });
    }
    scheduleAtMs = parsedAt;
  }

  const db = input.db ?? getAdminDb();
  const { roostRef, roost, versionId, versionUrl } = await loadDeployableRoost(
    db,
    siteId,
    roostId,
    explicitVersionId,
  );

  const machines = deployMachineSet(roost, explicitMachines);
  if (machines.length === 0) {
    throw validation(
      'no target machines — roost has empty targets[] and no machines[] override provided',
      { targets: ['empty'] },
    );
  }
  if (input.approvedMachines && !sameMachineSet(machines, input.approvedMachines)) {
    throw new RoostProblem({
      type: ProblemType.Conflict,
      title: 'machines changed',
      status: 409,
      detail: 'the machines this roost deploys to changed since they were checked; nothing was deployed',
      instance: `/api/roosts/${roostId}/deploy`,
      code: 'machines_changed',
    });
  }

  const extractRoot =
    typeof roost.extractPath === 'string' && roost.extractPath.trim().length > 0
      ? roost.extractPath.trim()
      : DEFAULT_EXTRACT_ROOT;

  const { canary, fleet } = splitCanary(machines, versionId);

  const rolloutRef = roostRef.collection('rollouts').doc(versionId);

  // Dry-run short-circuits BEFORE any writes.
  if (dryRun) {
    return {
      outcome: 'dry_run',
      status: 200,
      body: {
        rolloutId: versionId,
        versionId,
        siteId,
        roostId,
        stage: scheduleAtMs ? 'scheduled' : 'canary',
        canary,
        fleet,
        extractRoot,
        versionUrl,
        dryRun: true,
      },
    };
  }

  // Idempotent re-trigger: a non-terminal rollout for this version is returned
  // with alreadyRunning=true and no re-queue — the existing canary owns that wave.
  const existingRollout = await rolloutRef.get();
  if (existingRollout.exists) {
    const existing = existingRollout.data() ?? {};
    const stage = typeof existing.stage === 'string' ? existing.stage : 'canary';
    if (stage !== 'complete' && stage !== 'aborted') {
      return {
        outcome: 'already_running',
        status: 200,
        body: {
          rolloutId: versionId,
          versionId,
          siteId,
          roostId,
          stage,
          canary: Array.isArray(existing.canary) ? existing.canary : canary,
          fleet: Array.isArray(existing.fleet) ? existing.fleet : fleet,
          extractRoot: typeof existing.extractRoot === 'string' ? existing.extractRoot : extractRoot,
          versionUrl: typeof existing.versionUrl === 'string' ? existing.versionUrl : versionUrl,
          alreadyRunning: true,
        },
      };
    }
    // Terminal stage — allow a fresh rollout by overwriting below.
  }

  const batch = db.batch();
  const scheduled = typeof scheduleAtMs === 'number' && scheduleAtMs > Date.now() + 60_000;

  batch.set(rolloutRef, {
    stage: scheduled ? 'scheduled' : 'canary',
    versionId,
    versionUrl,
    extractRoot,
    canary,
    fleet,
    startedAt: FieldValue.serverTimestamp(),
    triggeredBy: input.requestedBy,
    ...(scheduled && typeof scheduleAtMs === 'number'
      ? { scheduledAt: Timestamp.fromMillis(scheduleAtMs) }
      : {}),
    ...(explicitMachines ? { targetsOverride: explicitMachines } : {}),
  });

  if (!scheduled) {
    // sync_pull commands for the canary wave, in the existing fan-out trigger's
    // write shape so agents need no protocol change.
    for (const machineId of canary) {
      const pendingRef = db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .doc(machineId)
        .collection('commands')
        .doc('pending');
      const cmdId = `roost_sync_${roostId}_${versionId}`;
      batch.set(
        pendingRef,
        {
          [cmdId]: {
            type: 'sync_pull',
            site_id: siteId,
            roost_id: roostId,
            version_id: versionId,
            version_url: versionUrl,
            extract_root: extractRoot,
            queued_at: FieldValue.serverTimestamp(),
          },
        },
        { merge: true },
      );
    }
  }

  await batch.commit();

  emitMutation({
    kind: 'roost_mutated',
    siteId,
    actor: ctx.auditActor,
    targetId: versionId,
    attributes: {
      verb: 'deploy',
      endpoint: input.endpoint,
      method: input.method,
      roostId,
      versionId,
      stage: scheduled ? 'scheduled' : 'canary',
      targetCount: machines.length,
      canaryCount: canary.length,
      scheduled,
    },
  });

  return {
    outcome: 'queued',
    status: 202,
    body: {
      rolloutId: versionId,
      versionId,
      siteId,
      roostId,
      stage: scheduled ? 'scheduled' : 'canary',
      canary,
      fleet,
      extractRoot,
      versionUrl,
      ...(scheduled && typeof scheduleAtMs === 'number'
        ? {
            scheduled: {
              at: new Date(scheduleAtMs).toISOString(),
              // Kept as `warning` because shipped sdk/cli clients read that
              // key; the copy states the sweep's real timing guarantees.
              warning:
                'the scheduler sweep fires this rollout within 5 minutes of the scheduled time; ' +
                'a rollout more than 30 minutes late is written off as missed rather than fired',
            },
          }
        : {}),
    },
  };
}

/** Inline canary split — 10% of machines, floor 1, cap 50, lexicographic for determinism. */
function splitCanary(machineIds: readonly string[], versionId: string): {
  canary: string[];
  fleet: string[];
} {
  void versionId;
  if (machineIds.length === 0) return { canary: [], fleet: [] };
  const canarySize = Math.max(
    CANARY_MIN,
    Math.min(CANARY_MAX, Math.ceil(machineIds.length * CANARY_FRACTION)),
  );
  const sorted = [...machineIds].sort();
  return {
    canary: sorted.slice(0, canarySize),
    fleet: sorted.slice(canarySize),
  };
}
