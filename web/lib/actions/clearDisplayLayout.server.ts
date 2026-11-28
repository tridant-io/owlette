/**
 * Action core: clear the assigned display layout from a machine's config
 * doc. After this fires there is no target layout for the agent to enforce
 * — the machine's display config stays whatever Windows decides on its
 * own (no auto-revert, no drift tracking).
 *
 * The same write turns auto-restore off: with no layout there is nothing to
 * restore, and a layout stored later must not bring it back without a
 * click. Merge-write with `FieldValue.delete()`, so the other `displays`
 * keys and auto-restore's history and circuit breaker survive.
 */
import { getAdminDb } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { emitMutation } from '@/lib/auditLogClient';
import logger from '@/lib/logger';
import type { ActionContext } from './createProcess.server';

export interface ClearDisplayLayoutInput {
  machineId: string;
}

export interface ClearDisplayLayoutResult {
  machineId: string;
}

export async function clearDisplayLayout(
  ctx: ActionContext,
  input: ClearDisplayLayoutInput,
): Promise<ClearDisplayLayoutResult> {
  const db = getAdminDb();
  const configRef = db
    .collection('config')
    .doc(ctx.siteId)
    .collection('machines')
    .doc(input.machineId);

  await configRef.set(
    {
      displays: {
        assigned: FieldValue.delete(),
        autoRestore: { enabled: false },
      },
    },
    { merge: true },
  );

  emitMutation({
    kind: 'process_mutated',
    siteId: ctx.siteId,
    actor: ctx.auditActor,
    targetId: input.machineId,
    attributes: {
      verb: 'clear',
      endpoint: 'display-layout',
      method: 'DELETE',
      machineId: input.machineId,
    },
  });

  logger.info(`Display layout cleared on ${input.machineId}`, {
    context: 'actions/clearDisplayLayout',
  });

  return { machineId: input.machineId };
}
