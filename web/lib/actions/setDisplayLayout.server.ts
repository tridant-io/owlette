/**
 * Set the display layout and auto-restore controls on a machine's config doc.
 * One action, discriminated by `op`:
 *
 *   capture          → assigned monitor topology + audit metadata under
 *                      `displays.assigned` (what the machine should look like
 *                      after a reboot or driver refresh); a first layout also
 *                      turns auto-restore off
 *   set_auto_restore → toggle `displays.autoRestore.enabled`; enable also stamps
 *                      enabledBy/enabledAt, disable leaves history intact
 *   reset_breaker    → clear the circuit breaker (tripped:false, failures:0)
 *
 * All three are merge-writes against `config/{siteId}/machines/{machineId}`, so
 * sibling fields survive.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import { ActionInputError, type ActionContext } from './createProcess.server';

export interface DisplayMonitorInput {
  /** Shape matches `MonitorInfo` in `useDisplayState`. Only checked here as a
   *  non-null object; the agent owns display geometry and validates it. */
  [key: string]: unknown;
}

export type SetDisplayLayoutInput =
  | {
      machineId: string;
      op: 'capture';
      monitors: DisplayMonitorInput[];
      capturedBy: string;
    }
  | {
      machineId: string;
      op: 'set_auto_restore';
      enabled: boolean;
      enabledBy?: string;
    }
  | {
      machineId: string;
      op: 'reset_breaker';
    }
  | {
      machineId: string;
      op: 'set_remote_apply';
      enabled: boolean;
    };

export interface SetDisplayLayoutResult {
  machineId: string;
  op: SetDisplayLayoutInput['op'];
}

function readPosition(monitor: DisplayMonitorInput): { x: number; y: number } | null {
  const position = monitor.position;
  if (!position || typeof position !== 'object' || Array.isArray(position)) {
    return null;
  }
  const { x, y } = position as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

function normalizePrimaryToOrigin(monitors: DisplayMonitorInput[]): DisplayMonitorInput[] {
  const primary = monitors.find((monitor) => monitor.primary === true);
  if (!primary) return monitors;
  const primaryPosition = readPosition(primary);
  if (!primaryPosition) return monitors;
  const { x: dx, y: dy } = primaryPosition;
  if (dx === 0 && dy === 0) return monitors;

  return monitors.map((monitor) => {
    const position = readPosition(monitor);
    if (!position) return monitor;
    return {
      ...monitor,
      position: {
        ...(monitor.position as Record<string, unknown>),
        x: position.x - dx,
        y: position.y - dy,
      },
    };
  });
}

export async function setDisplayLayout(
  ctx: ActionContext,
  input: SetDisplayLayoutInput,
): Promise<SetDisplayLayoutResult> {
  const db = getAdminDb();
  const configRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('machines')
    .doc(input.machineId);

  if (input.op === 'capture') {
    if (!Array.isArray(input.monitors) || input.monitors.length === 0) {
      throw new ActionInputError(
        400,
        'missing_monitors',
        'Field `monitors` must be a non-empty array.',
      );
    }
    if (typeof input.capturedBy !== 'string' || input.capturedBy.length === 0) {
      throw new ActionInputError(
        400,
        'missing_captured_by',
        'Field `capturedBy` is required.',
      );
    }
    for (const m of input.monitors) {
      if (m === null || typeof m !== 'object' || Array.isArray(m)) {
        throw new ActionInputError(
          400,
          'invalid_monitor',
          'Each monitor must be an object.',
        );
      }
    }
    const monitors = normalizePrimaryToOrigin(input.monitors);
    const capturedBy = input.capturedBy;
    await db.runTransaction(async (tx) => {
      const prior = (await tx.get(configRef)).data()?.displays?.assigned?.monitors;
      // auto-restore is on only if someone turned it on while a layout was stored. machines
      // cleared before clear turned it off still hold the flag on with no layout, so a first
      // layout must not arm it
      const firstLayout = !Array.isArray(prior) || prior.length === 0;
      tx.set(
        configRef,
        {
          displays: {
            assigned: {
              monitors,
              capturedAt: FieldValue.serverTimestamp(),
              capturedBy,
            },
            ...(firstLayout ? { autoRestore: { enabled: false } } : {}),
          },
        },
        { merge: true },
      );
    });
  } else if (input.op === 'set_auto_restore') {
    if (typeof input.enabled !== 'boolean') {
      throw new ActionInputError(
        400,
        'invalid_enabled',
        'Field `enabled` must be a boolean.',
      );
    }
    if (input.enabled && (typeof input.enabledBy !== 'string' || input.enabledBy.length === 0)) {
      throw new ActionInputError(
        400,
        'missing_enabled_by',
        'Field `enabledBy` is required when enabling auto-restore.',
      );
    }
    const autoRestorePatch = input.enabled
      ? {
          enabled: true,
          enabledBy: input.enabledBy,
          enabledAt: FieldValue.serverTimestamp(),
        }
      : { enabled: false };
    await configRef.set(
      { displays: { autoRestore: autoRestorePatch } },
      { merge: true },
    );
  } else if (input.op === 'reset_breaker') {
    await configRef.set(
      {
        displays: {
          autoRestore: {
            circuitBreaker: { tripped: false, failures: 0 },
          },
        },
      },
      { merge: true },
    );
  } else if (input.op === 'set_remote_apply') {
    if (typeof input.enabled !== 'boolean') {
      throw new ActionInputError(
        400,
        'invalid_enabled',
        'Field `enabled` must be a boolean.',
      );
    }
    await configRef.set(
      {
        displays: {
          remoteApplyEnabled: input.enabled,
        },
      },
      { merge: true },
    );
  } else {
    // Exhaustiveness guard — TS catches missing branches at compile time.
    const _exhaustive: never = input;
    throw new ActionInputError(400, 'invalid_op', `Unknown op: ${JSON.stringify(_exhaustive)}`);
  }

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: input.machineId,
    attributes: {
      verb: input.op,
      endpoint: 'display-layout',
      method: 'PUT',
      machineId: input.machineId,
    },
  });

  logger.info(`Display layout op=${input.op} on ${input.machineId}`, {
    context: 'actions/setDisplayLayout',
  });

  return { machineId: input.machineId, op: input.op };
}
