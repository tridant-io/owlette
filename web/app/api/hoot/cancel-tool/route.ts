/**
 * POST /api/hoot/cancel-tool — cancel an in-flight hoot tool call.
 *
 * Body: `{ siteId, machineId, chatId, commandId }`; `commandId` is the running
 * `mcp_tool_call`'s agent command id, from `stream/current.toolCommands`.
 *
 * Authorization, in order: resolveAuth (401) → requireScope(chat=<siteId>:write), api-key
 * callers only → verifyUserSiteAccess → chat must exist on `siteId` and belong to the
 * caller → `commandId` must appear in that chat's `toolCommands` index AND the request's
 * machineId must match the key it was recorded under. The last check is what stops a caller
 * cancelling arbitrary machine commands through a chat they happen to own.
 *
 * Dispatch is the USER-actor path (`executeMachineCommand`, never `invokeAsSystem` — actor
 * type is load-bearing for audit). Agent side is `_handle_cancel_mcp_tool` in
 * agent/src/firebase_client.py: kills the process tree, writes the target's terminal
 * `cancelled` entry, acks the cancel.
 *
 * 200 with the ack when it lands within ~10s, else 202 `{ accepted: true }` — the tool card
 * resolves via the stream doc either way.
 */

import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { ApiAuthError, resolveAuth, requireScope } from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { apiError } from '@/lib/apiErrorResponse';
import { verifyUserSiteAccess } from '@/lib/hoot-utils.server';
import {
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import { getUserIdFromSession, withRateLimit } from '@/lib/withRateLimit';
import { siteStanding, type Actor, type Role } from '@/lib/capabilities';

/** `stream/current.toolCommands`: toolCallId → machineId → { commandId }. Declared locally
 * to keep this route off the server-only turn store's type surface. */
type ToolCommandsIndex = Record<string, Record<string, { commandId: string }>>;

/** How long to wait for the agent's cancel ack before returning 202. */
const CANCEL_ACK_TIMEOUT_MS = 10_000;

/** Interval between `commands/completed` polls while waiting for the ack. */
const CANCEL_ACK_POLL_INTERVAL_MS = 1_000;

interface CancelToolBody {
  siteId?: unknown;
  machineId?: unknown;
  chatId?: unknown;
  commandId?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Poll `commands/completed` for the CANCEL command's own ack: immediately, then every second
 * to the deadline. `status: 'running'` is the agent's in-flight marker — non-terminal, keep
 * polling. Consumed acks are deleted best-effort so the doc doesn't grow unbounded.
 */
async function pollForCancelAck(
  db: FirebaseFirestore.Firestore,
  siteId: string,
  machineId: string,
  cancelCommandId: string,
): Promise<Record<string, unknown> | null> {
  const completedRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('completed');
  const deadline = Date.now() + CANCEL_ACK_TIMEOUT_MS;

  for (;;) {
    const snap = await completedRef.get();
    const entry = snap.exists
      ? ((snap.data() ?? {})[cancelCommandId] as Record<string, unknown> | undefined)
      : undefined;
    if (entry && entry.status !== 'running') {
      await completedRef
        .update({ [cancelCommandId]: FieldValue.delete() })
        .catch(() => undefined);
      return entry;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, CANCEL_ACK_POLL_INTERVAL_MS));
  }
}

async function handleCancelTool(request: NextRequest): Promise<NextResponse> {
  try {
    const auth = await resolveAuth(request);

    const body = (await request.json().catch(() => null)) as CancelToolBody | null;
    const siteId = body?.siteId;
    const machineId = body?.machineId;
    const chatId = body?.chatId;
    const commandId = body?.commandId;

    if (
      !isNonEmptyString(siteId) ||
      !isNonEmptyString(machineId) ||
      !isNonEmptyString(chatId) ||
      !isNonEmptyString(commandId)
    ) {
      return NextResponse.json(
        { error: 'siteId, machineId, chatId, and commandId are required' },
        { status: 400 },
      );
    }

    // api-key callers only; session/ID-token auth is covered by the site-access check below.
    requireScope(auth, 'chat', siteId, 'write');

    const db = getAdminDb();

    let access;
    try {
      access = await verifyUserSiteAccess(db, auth.userId, siteId);
    } catch {
      return NextResponse.json(
        { error: 'you do not have access to this site' },
        { status: 403 },
      );
    }

    // Chat-scoped and owner-only.
    const chatSnap = await db.collection('chats').doc(chatId).get();
    const chatData = chatSnap.data();
    if (!chatSnap.exists || chatData?.siteId !== siteId) {
      return NextResponse.json({ error: 'chat not found' }, { status: 404 });
    }
    if (chatData?.userId !== auth.userId) {
      return NextResponse.json({ error: 'you do not own this chat' }, { status: 403 });
    }

    // The commandId must be one this chat's current turn dispatched, and machineId must
    // match the key it was recorded under — otherwise a chat the caller owns becomes a
    // lever on arbitrary machine commands.
    const streamSnap = await db
      .collection('chats')
      .doc(chatId)
      .collection('stream')
      .doc('current')
      .get();
    const toolCommands = (streamSnap.data()?.toolCommands ?? {}) as ToolCommandsIndex;
    // Which machine key recorded this commandId, across every tool call.
    let recordedMachineId: string | null = null;
    for (const perMachine of Object.values(toolCommands)) {
      if (!perMachine || typeof perMachine !== 'object') continue;
      for (const [recordedMid, entry] of Object.entries(perMachine)) {
        if (entry?.commandId === commandId) {
          recordedMachineId = recordedMid;
          break;
        }
      }
      if (recordedMachineId !== null) break;
    }
    if (recordedMachineId === null) {
      return NextResponse.json(
        { error: 'unknown commandId for this chat' },
        { status: 400 },
      );
    }
    if (recordedMachineId !== machineId) {
      return NextResponse.json(
        { error: 'commandId does not belong to this machine' },
        { status: 400 },
      );
    }

    // USER-actor dispatch — never invokeAsSystem for user-initiated work.
    const role: Role =
      access.role === 'superadmin' || access.role === 'admin' ? access.role : 'member';
    const actor: Actor = {
      type: 'user',
      userId: auth.userId,
      ...(auth.keyContext ? { apiKeyId: auth.keyContext.keyId } : {}),
      role,
      // Per-site standing from the same access check above; the global `role`
      // beside it grants nothing on a site.
      ...siteStanding([[siteId, { role: access.siteRole, swoopMode: access.swoopMode, machineIds: null }]]),
    };

    let queued;
    try {
      queued = await executeMachineCommand(
        {
          siteId,
          machineId,
          actor,
          auditActor: auth.keyContext
            ? `apiKey:${auth.keyContext.keyId}`
            : `user:${auth.userId}`,
        },
        {
          type: 'cancel_mcp_tool',
          payload: { target_command_id: commandId },
        },
        { db },
      );
    } catch (err) {
      if (err instanceof ExecuteMachineCommandError) {
        return NextResponse.json(
          { error: err.detail, code: err.code },
          { status: err.status },
        );
      }
      throw err;
    }

    const ack = await pollForCancelAck(db, siteId, machineId, queued.commandId);
    if (ack) {
      return NextResponse.json({ accepted: true, commandId: queued.commandId, ack });
    }

    // Slow ack: the agent still processes the cancel and the stream doc resolves the card.
    return NextResponse.json(
      { accepted: true, commandId: queued.commandId },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof ApiAuthError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status },
      );
    }
    return apiError(error, 'hoot/cancel-tool');
  }
}

export const POST = withRateLimit(handleCancelTool, {
  strategy: 'user',
  identifier: 'user',
  getUserId: getUserIdFromSession,
});
