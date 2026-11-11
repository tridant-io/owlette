/**
 * Talon run engine — trigger → condition → outputs. The single execution path:
 * scheduler sweep, event router, and "run now" all land here so cooldown, the
 * in-flight guard, run recording, and auto-disable exist in exactly one place.
 *
 * One `talon_runs/{runId}` doc per execution, written `running` up front and
 * finalized in place. A `visual_check` condition is inherently per-machine, so
 * those talons produce one run PER TARGET MACHINE; everything else produces a
 * single site-level run.
 *
 * Skips are recorded, not swallowed: the reason goes in the run's `error`
 * (`already_running`, `machine_offline`, `no_interactive_session`) — operators
 * read it off the run list, and it is not the same fact as "failed". Two skips
 * write no run at all: a disabled talon, and one inside its cooldown (a hot
 * threshold would bury the real runs under hundreds of cooldown records).
 *
 * `consecutiveFailures` counts failed *executions*, not outputs, resets on any
 * success, and disables the talon at {@link AUTO_DISABLE_AFTER_FAILURES}. It
 * covers TRANSIENT faults only — a run carrying a `disabledReason` hit
 * something no retry fixes (author gone, no ai key) and disables the talon on
 * that single run, reason stored on both docs so the operator is told why.
 */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import { generateCorrelationId } from '@/lib/auditLog.server';
import type { Actor } from '@/lib/capabilities';
import { timestampToMs } from '@/lib/firestoreTime.server';
import logger from '@/lib/logger';
import { TalonAuthorError, resolveTalonAuthor } from './author.server';
import {
  executeTalonOutput,
  resolveBaseUrl,
  type TalonOutputContext,
} from './outputs.server';
import { getTalon, TalonStoreError, type StoredTalon } from './store.server';
import type {
  TalonDisabledReason,
  TalonRunCondition,
  TalonRunDoc,
  TalonRunOutput,
  TalonRunStatus,
  TalonTrigger,
} from './types';
import { evaluateVisualCheck, TalonVisualCheckError } from './visualCheck.server';

/** Consecutive failed runs before the talon disables itself. */
export const AUTO_DISABLE_AFTER_FAILURES = 10;

/**
 * How long a `running` run may sit before the next execution takes it over —
 * longer than any legitimate run (visual check = 45s capture + model call),
 * short enough that a process killed mid-run doesn't wedge the talon.
 */
export const STALE_RUN_MS = 10 * 60_000;

/** Sentinel `machineId` on the companion log entry for a site-level run. */
const SITE_LOG_SENTINEL = 'site';

/** What fired the talon, and how the run should be recorded. */
export interface TalonRunContext {
  siteId: string;
  /** Human-readable, lowercase. Derived from the trigger when omitted. */
  triggerSummary?: string;
  /** The machine the trigger fired for — a threshold breach or a machine event. */
  machineId?: string;
  /** Operator-initiated: bypasses the cooldown and stamps `manual` on the run. */
  manual?: boolean;
  /** Injectable clock for tests; production omits it. */
  now?: Date;
}

/** What one execution did, returned in the order the runs were recorded. */
export interface TalonRunSummary {
  runId: string;
  status: TalonRunStatus;
  machineId?: string;
  outputs: TalonRunOutput[];
  condition?: TalonRunCondition;
  /** Skip reason or failure detail, mirroring the run document's `error`. */
  error?: string;
  /**
   * Set when this run hit something no retry can fix — see
   * {@link TalonDisabledReason}. `settleTalon` disables the talon on the spot
   * rather than waiting for {@link AUTO_DISABLE_AFTER_FAILURES}.
   */
  disabledReason?: TalonDisabledReason;
}

interface TargetMachine {
  id: string;
  name: string;
  online: boolean;
}

/**
 * The minimum needed to WRITE a run and its companion log. Split out from
 * {@link RunEnvironment} so the in-flight guard can record its skip without
 * first paying for the site read and scope resolution a real run needs.
 */
interface RunRecordEnv {
  db: Firestore;
  siteId: string;
  triggerSummary: string;
  manual: boolean;
  now: Date;
}

/** Everything the per-run executor needs that is constant across a talon's runs. */
interface RunEnvironment extends RunRecordEnv {
  siteName: string;
  siteLabel: string;
  baseUrl: string;
  /** Machines a `command` output acts on. */
  targetMachineIds: string[];
}

function talonRef(db: Firestore, siteId: string, talonId: string) {
  return db.collection('sites').doc(siteId).collection('talons').doc(talonId);
}

function talonRunsCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('talon_runs');
}

function machinesCollection(db: Firestore, siteId: string) {
  return db.collection('sites').doc(siteId).collection('machines');
}

/** Lowercase one-liner describing why the talon fired, stored on every run. */
export function describeTrigger(trigger: TalonTrigger): string {
  switch (trigger.type) {
    case 'schedule': {
      if (typeof trigger.intervalMinutes === 'number') {
        return `every ${trigger.intervalMinutes} minutes`;
      }
      const entries = trigger.entries ?? [];
      if (entries.length === 1) {
        return `scheduled ${entries[0].days.join('/')} at ${entries[0].time}`;
      }
      return `scheduled (${entries.length} times)`;
    }
    case 'threshold':
      return `${trigger.metric} ${trigger.operator} ${trigger.value}`;
    case 'event': {
      const events = `on ${trigger.eventTypes.join(', ')}`;
      // The delay is part of the identity: hiding it misreports why it fired late.
      return trigger.delayMinutes ? `${events} · after ${trigger.delayMinutes} min` : events;
    }
  }
}

/**
 * Execute a talon.
 *
 * @returns one summary per run recorded — empty when a guard stopped the talon
 *          before any run existed (disabled, or still cooling down).
 */
export async function runTalon(
  db: Firestore,
  talon: StoredTalon,
  context: TalonRunContext,
): Promise<TalonRunSummary[]> {
  const { siteId } = context;
  const now = context.now ?? new Date();

  // Disabled never runs, not even on demand — "run now" on a talon just
  // switched off would surprise the operator.
  if (!talon.enabled) return [];

  if (!context.manual && isCoolingDown(talon, now)) return [];

  const inFlight = await claimInFlight(db, siteId, talon, now);
  if (inFlight) return [inFlight];

  const site = await readSite(db, siteId);
  const needsMachines =
    talon.condition.type === 'visual_check' ||
    talon.outputs.some((output) => output.type === 'command');
  const targets = needsMachines ? await resolveTargets(db, siteId, talon.scope.machineIds) : [];

  const env: RunEnvironment = {
    db,
    siteId,
    siteName: site.name,
    siteLabel: site.label,
    baseUrl: resolveBaseUrl(),
    triggerSummary: context.triggerSummary ?? describeTrigger(talon.trigger),
    manual: context.manual === true,
    now,
    targetMachineIds: targets.map((target) => target.id),
  };

  const summaries: TalonRunSummary[] = [];

  if (talon.condition.type === 'visual_check') {
    for (const target of targets) {
      // Sequential: the agent throttles `capture_screenshot` to 1/5s per machine.
      summaries.push(
        target.online
          ? await executeRun(env, talon, target)
          : await recordTerminalRun(env, talon, 'skipped', 'machine_offline', target),
      );
    }
  } else {
    const machine = context.machineId
      ? await readMachine(db, siteId, context.machineId)
      : undefined;
    summaries.push(await executeRun(env, talon, machine));
  }

  await settleTalon(db, siteId, talon, summaries, now);
  return summaries;
}

/**
 * Run a talon on demand: bypasses the cooldown (the operator overrode it) and
 * stamps `manual` so the run list distinguishes it from a scheduled fire.
 *
 * @throws {TalonStoreError} 404 when the site has no talon with that id.
 */
export async function runTalonManual(
  db: Firestore,
  siteId: string,
  talonId: string,
  actor: Actor,
): Promise<TalonRunSummary[]> {
  const talon = await getTalon(db, siteId, talonId);
  if (!talon) {
    throw new TalonStoreError(404, 'talon_not_found', `talon \`${talonId}\` was not found.`);
  }

  logger.info(`Talon manual run: ${talonId} on ${siteId} by ${describeActor(actor)}`, {
    context: 'talons/engine',
  });

  return runTalon(db, talon, { siteId, manual: true, triggerSummary: 'manual run' });
}

function describeActor(actor: Actor): string {
  return actor.type === 'user' ? `user:${actor.userId}` : `system:${actor.name}`;
}

/**
 * Threshold and event triggers only: a schedule already carries its spacing in
 * `nextRunAt`, and cooling it too would silently drop fires whose interval is
 * shorter than the independently configured cooldown.
 */
function isCoolingDown(talon: StoredTalon, now: Date): boolean {
  if (talon.trigger.type === 'schedule') return false;
  if (talon.cooldownMinutes <= 0) return false;
  const lastRunMs = timestampToMs(talon.lastRunAt);
  if (lastRunMs === null) return false;
  return now.getTime() - lastRunMs < talon.cooldownMinutes * 60_000;
}

/**
 * Enforce one in-flight run per talon. A run inside {@link STALE_RUN_MS} wins
 * and this execution records a `skipped` run; an older one is presumed dead
 * (process killed or redeployed mid-run), closed out `failed`/`stale`, and this
 * execution proceeds — otherwise one crash wedges the talon permanently.
 *
 * @returns the recorded skip when another run holds the slot, else `null`.
 */
async function claimInFlight(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  now: Date,
): Promise<TalonRunSummary | null> {
  const snapshot = await talonRunsCollection(db, siteId)
    .where('talonId', '==', talon.id)
    .where('status', '==', 'running')
    .get();

  let blocked = false;
  for (const doc of snapshot.docs) {
    const startedMs = timestampToMs((doc.data() as TalonRunDoc).startedAt);
    const fresh = startedMs !== null && now.getTime() - startedMs < STALE_RUN_MS;
    if (fresh) {
      blocked = true;
      continue;
    }
    await doc.ref.update({
      status: 'failed',
      error: 'stale',
      completedAt: now,
      ...(startedMs !== null ? { durationMs: now.getTime() - startedMs } : {}),
    });
    logger.warn(`Talon run ${doc.id} was stale and has been closed out`, {
      context: 'talons/engine',
      data: { siteId, talonId: talon.id },
    });
  }

  if (!blocked) return null;

  // Talon bookkeeping deliberately untouched: the run holding the slot is still
  // going and stamps `lastRunAt` itself when it lands.
  return recordTerminalRun(
    { db, siteId, triggerSummary: describeTrigger(talon.trigger), manual: false, now },
    talon,
    'skipped',
    'already_running',
  );
}

/** Site name + the `"name (siteId)"` label alert emails show, in one read. */
async function readSite(db: Firestore, siteId: string): Promise<{ name: string; label: string }> {
  try {
    const snapshot = await db.collection('sites').doc(siteId).get();
    const name = (snapshot.data()?.name as string | undefined)?.trim();
    if (!name || name === siteId) return { name: siteId, label: siteId };
    return { name, label: `${name} (${siteId})` };
  } catch {
    return { name: siteId, label: siteId };
  }
}

async function readMachine(
  db: Firestore,
  siteId: string,
  machineId: string,
): Promise<TargetMachine | undefined> {
  try {
    const snapshot = await machinesCollection(db, siteId).doc(machineId).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() ?? {};
    return {
      id: machineId,
      name: (data.name as string | undefined) || machineId,
      online: data.online === true,
    };
  } catch {
    return undefined;
  }
}

/** The talon's scope resolved to real machines — its explicit list, or the whole site. */
async function resolveTargets(
  db: Firestore,
  siteId: string,
  machineIds: string[] | null,
): Promise<TargetMachine[]> {
  if (machineIds !== null) {
    const resolved: TargetMachine[] = [];
    for (const machineId of machineIds) {
      const machine = await readMachine(db, siteId, machineId);
      // A machine that was removed from the site after the talon was authored
      // is not a run with no target — it is simply no longer in scope.
      if (machine) resolved.push(machine);
    }
    return resolved;
  }

  const snapshot = await machinesCollection(db, siteId).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      id: doc.id,
      name: (data.name as string | undefined) || doc.id,
      online: data.online === true,
    };
  });
}

function baseRunDoc(
  env: RunRecordEnv,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
  correlationId: string,
): TalonRunDoc {
  return {
    talonId: talon.id,
    talonName: talon.name,
    triggerType: talon.trigger.type,
    triggerSummary: env.triggerSummary,
    ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
    status: 'running',
    startedAt: env.now,
    outputs: [],
    correlationId,
    ...(talon.chatId ? { chatId: talon.chatId } : {}),
    ...(env.manual ? { manual: true } : {}),
  };
}

/** A run that is over before it starts — recorded whole, in one write. */
async function recordTerminalRun(
  env: RunRecordEnv,
  talon: StoredTalon,
  status: TalonRunStatus,
  error: string,
  machine?: TargetMachine,
): Promise<TalonRunSummary> {
  const ref = talonRunsCollection(env.db, env.siteId).doc();
  await ref.set({
    ...baseRunDoc(env, talon, machine, generateCorrelationId()),
    status,
    error,
    completedAt: env.now,
    durationMs: 0,
  });

  await writeRunLog(env, talon, status, machine, error);
  return { runId: ref.id, status, machineId: machine?.id, outputs: [], error };
}

/**
 * Execute one run end to end: create the record, evaluate the condition,
 * re-check the author, fire the outputs in order, finalize.
 */
async function executeRun(
  env: RunEnvironment,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
): Promise<TalonRunSummary> {
  const correlationId = generateCorrelationId();
  const ref = talonRunsCollection(env.db, env.siteId).doc();
  await ref.set(baseRunDoc(env, talon, machine, correlationId));
  await writeRunLog(env, talon, 'running', machine);

  const startedMs = Date.now();

  let condition: TalonRunCondition | undefined;
  let conditionForOutputs: TalonRunCondition | undefined;

  if (talon.condition.type === 'visual_check' && machine) {
    try {
      const result = await evaluateVisualCheck(
        env.db,
        env.siteId,
        machine.id,
        talon,
        talon.condition,
        correlationId,
      );
      condition = {
        type: 'visual_check',
        verdict: result.verdict,
        confidence: result.confidence,
        reason: result.reason,
        // PATH only: signed urls expire in ~1h and the object at 30 days, so a
        // persisted url would be a dead link on a longer-lived run record.
        ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
      };
      conditionForOutputs = result.screenshotUrl
        ? { ...condition, screenshotUrl: result.screenshotUrl }
        : condition;
    } catch (error) {
      return finalizeConditionError(env, talon, machine, ref, startedMs, error);
    }
  }

  let outputs: TalonRunOutput[];
  if (condition && condition.verdict === 'pass') {
    // Expectation held — nothing to react to. Recorded per output rather than
    // as an empty list so the run has the same shape either way.
    outputs = talon.outputs.map((output) => ({
      type: output.type,
      status: 'skipped' as const,
      detail: 'condition_passed',
    }));
  } else {
    const refusal = await authorRefusal(env.db, env.siteId, talon);
    if (refusal) {
      outputs = talon.outputs.map((output) => ({ type: output.type, ...refusal }));
    } else {
      const outputCtx: TalonOutputContext = {
        db: env.db,
        siteId: env.siteId,
        siteLabel: env.siteLabel,
        siteName: env.siteName,
        talon,
        talonId: talon.id,
        talonName: talon.name,
        triggerSummary: env.triggerSummary,
        runId: ref.id,
        correlationId,
        ...(machine ? { machineId: machine.id, machineName: machine.name } : {}),
        // Machine-scoped run targets its own machine; site-level fans out.
        targetMachineIds: machine ? [machine.id] : env.targetMachineIds,
        ...(conditionForOutputs ? { condition: conditionForOutputs } : {}),
        baseUrl: env.baseUrl,
        now: env.now,
      };

      outputs = [];
      for (const output of talon.outputs) {
        // Sequential + individually recorded: one failure must not stop the rest.
        outputs.push(await executeTalonOutput(outputCtx, output));
      }
    }
  }

  const status: TalonRunStatus = outputs.some((output) => output.status === 'failed')
    ? 'failed'
    : 'succeeded';

  // A hoot output opens a fresh chat per run; that beats the talon's authoring
  // chat as the run's `chatId` (the latter already lives on the talon doc).
  const hootChatId = findHootChatId(outputs);

  // First-wins: several outputs can hit the same dead author, one stated reason.
  const disabledReason = outputs.find((output) => output.disabledReason)?.disabledReason;

  await ref.update({
    status,
    outputs,
    ...(condition ? { condition } : {}),
    ...(hootChatId ? { chatId: hootChatId } : {}),
    ...(disabledReason ? { disabledReason } : {}),
    completedAt: env.now,
    durationMs: Date.now() - startedMs,
  });

  await writeRunLog(env, talon, status, machine, summarizeOutputs(outputs));
  return {
    runId: ref.id,
    status,
    machineId: machine?.id,
    outputs,
    ...(condition ? { condition } : {}),
    ...(disabledReason ? { disabledReason } : {}),
  };
}

/**
 * a talon acts on its author's authority, so whatever its outputs, the author
 * is re-resolved before the first one fires. `null` lets them fire; otherwise
 * each records this instead, as a hoot output records its own author check: an
 * unrecoverable refusal carries the reason that switches the talon off now, and
 * an unreadable check stays on the failure counter. either way nothing fires.
 * the hoot output and the visual check still resolve it themselves, since
 * neither takes a resolved author.
 */
async function authorRefusal(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
): Promise<Omit<TalonRunOutput, 'type'> | null> {
  try {
    await resolveTalonAuthor(db, siteId, talon);
    return null;
  } catch (error) {
    if (error instanceof TalonAuthorError) {
      return {
        status: 'failed',
        detail: error.reason,
        error: error.message,
        disabledReason: error.reason,
      };
    }
    return {
      status: 'failed',
      detail: 'author_check_failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Close out a run whose condition produced no verdict. `machine_offline` and
 * `no_interactive_session` are `skipped` (machine wasn't checkable — not the
 * talon's fault, so no auto-disable credit); `capture_failed`/`verdict_error`
 * fail the run; `author_unavailable` fails it AND disables the talon, since the
 * key behind the check won't be back next firing.
 */
async function finalizeConditionError(
  env: RunEnvironment,
  talon: StoredTalon,
  machine: TargetMachine | undefined,
  ref: DocumentReference,
  startedMs: number,
  error: unknown,
): Promise<TalonRunSummary> {
  const code = error instanceof TalonVisualCheckError ? error.code : 'verdict_error';
  const benign = code === 'machine_offline' || code === 'no_interactive_session';
  const status: TalonRunStatus = benign ? 'skipped' : 'failed';
  const detail = benign
    ? code
    : `${code}: ${error instanceof Error ? error.message : String(error)}`;
  const disabledReason =
    error instanceof TalonVisualCheckError ? error.disabledReason : undefined;

  await ref.update({
    status,
    error: detail,
    ...(disabledReason ? { disabledReason } : {}),
    completedAt: env.now,
    durationMs: Date.now() - startedMs,
  });

  await writeRunLog(env, talon, status, machine, detail);
  return {
    runId: ref.id,
    status,
    machineId: machine?.id,
    outputs: [],
    error: detail,
    ...(disabledReason ? { disabledReason } : {}),
  };
}

/**
 * The chat a `cortex` output dispatched into. Only a `sent` entry carries a chat
 * id — a failed output's `detail` is a failure reason and would be a dead link.
 * Multiple hoot outputs are legal; the run doc has one `chatId`, so first wins
 * (the rest stay in `outputs[].detail`).
 */
function findHootChatId(outputs: TalonRunOutput[]): string | undefined {
  const hoot = outputs.find((output) => output.type === 'cortex' && output.status === 'sent');
  return hoot?.detail;
}

function summarizeOutputs(outputs: TalonRunOutput[]): string {
  if (outputs.length === 0) return 'no outputs';
  return outputs
    .map((output) => `${output.type}: ${output.status}${output.detail ? ` (${output.detail})` : ''}`)
    .join('; ');
}

const LOG_ACTION_BY_STATUS: Readonly<
  Record<TalonRunStatus, { action: string; level: 'info' | 'warning' | 'error' }>
> = {
  running: { action: 'talon_triggered', level: 'info' },
  succeeded: { action: 'talon_succeeded', level: 'info' },
  failed: { action: 'talon_failed', level: 'error' },
  skipped: { action: 'talon_skipped', level: 'warning' },
  missed: { action: 'talon_skipped', level: 'warning' },
  // Deferral statuses the engine never writes (matcher creates, sweep resolves).
  // Kept so the map stays total: a new status is a compile error, not an
  // `undefined` destructure at runtime.
  pending: { action: 'talon_triggered', level: 'info' },
  fired: { action: 'talon_triggered', level: 'info' },
};

/**
 * Mirror the run into `sites/{siteId}/logs`, the feed operators watch.
 *
 * `timestamp`, `action`, `level`, `machineId` are all required by
 * firestore.rules (`hasRequiredFields`) — omitting any one is rejected, so a
 * site-level run writes the `'site'` sentinel. Best-effort: a failed log write
 * must not fail the run it describes.
 */
async function writeRunLog(
  env: RunRecordEnv,
  talon: StoredTalon,
  status: TalonRunStatus,
  machine: TargetMachine | undefined,
  details?: string,
): Promise<void> {
  const { action, level } = LOG_ACTION_BY_STATUS[status];
  try {
    await env.db
      .collection('sites')
      .doc(env.siteId)
      .collection('logs')
      .add({
        timestamp: env.now,
        action,
        level,
        machineId: machine?.id ?? SITE_LOG_SENTINEL,
        machineName: machine?.name ?? SITE_LOG_SENTINEL,
        details: details
          ? `${talon.name} — ${env.triggerSummary} — ${details}`
          : `${talon.name} — ${env.triggerSummary}`,
      });
  } catch (error) {
    logger.warn(`Talon companion log write failed for ${talon.id}`, {
      context: 'talons/engine',
      data: { siteId: env.siteId, error: String(error) },
    });
  }
}

/**
 * Denormalize the execution onto the talon doc and apply the auto-disable
 * backoff. One write per execution, not per run. Status is the worst of its
 * runs — failing on one of four machines must not read as "succeeded".
 */
async function settleTalon(
  db: Firestore,
  siteId: string,
  talon: StoredTalon,
  summaries: TalonRunSummary[],
  now: Date,
): Promise<void> {
  if (summaries.length === 0) return;

  const status: TalonRunStatus = summaries.some((summary) => summary.status === 'failed')
    ? 'failed'
    : summaries.some((summary) => summary.status === 'succeeded')
      ? 'succeeded'
      : 'skipped';

  let consecutiveFailures = talon.consecutiveFailures ?? 0;
  if (status === 'failed') consecutiveFailures += 1;
  else if (status === 'succeeded') consecutiveFailures = 0;
  // Skipped leaves the counter alone: proves nothing either way.

  // Unrecoverable reasons short-circuit the counter — no point spending ten
  // firings rediscovering that the author left the site.
  const fatalReason = summaries.find((summary) => summary.disabledReason)?.disabledReason;
  const disabledReason: TalonDisabledReason | undefined =
    fatalReason ?? (consecutiveFailures >= AUTO_DISABLE_AFTER_FAILURES ? 'repeated_failures' : undefined);

  const updates: Record<string, unknown> = {
    lastRunAt: now,
    lastRunStatus: status,
    lastRunId: summaries[summaries.length - 1].runId,
    consecutiveFailures,
    ...(disabledReason ? { enabled: false, disabledReason, updatedAt: now } : {}),
  };

  await talonRef(db, siteId, talon.id).update(updates);

  if (!disabledReason) return;

  emitMutation({
    kind: 'talon_mutated',
    siteId,
    actor: 'system:talon_runner',
    targetId: talon.id,
    attributes: {
      verb: 'talon.disable',
      endpoint: `/api/sites/${siteId}/talons/${talon.id}`,
      method: 'PATCH',
      changedFields: ['enabled', 'disabledReason'],
      reason: disabledReason,
      consecutiveFailures,
    },
  });

  logger.warn(
    fatalReason
      ? `Talon ${talon.id} disabled immediately: ${fatalReason}`
      : `Talon ${talon.id} disabled after ${consecutiveFailures} consecutive failed runs`,
    { context: 'talons/engine', data: { siteId } },
  );
}
