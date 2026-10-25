/**
 * GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *
 * Poll a queued command. Merges the `pending` and `completed` Firestore docs into
 * one status: progress markers (`running`, `downloading`, `installing`) live on
 * the `completed` doc as non-terminal and surface as `in_progress`; only
 * `completed`/`failed`/`error`/`cancelled` resolve the command. For finished
 * `capture_screenshot` commands, mints a fresh 1-hour signed read URL per request
 * into `result.screenshot_url` — the URL itself is never persisted.
 *
 * Auth: `machine=<id>:read` (api key) OR site membership (session/id-token).
 * api-sprint wave 2 — track 2A (machine-api MVP).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { issueScreenshotReadUrl } from '@/lib/screenshotStorage.server';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string; commandId: string }>;
}

const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{1,80}$/;

type CommandStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Only these statuses resolve a command. The agent also writes non-terminal
 * markers to the completed doc — `running` (restart-safety, written at command
 * start), `downloading`, `installing` — which must surface as `in_progress`.
 * `cancelled` has no CommandStatus variant and maps to `failed` at resolve time.
 */
const TERMINAL_COMMAND_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
]);

interface CommandLookup {
  status: CommandStatus;
  data: Record<string, unknown>;
  source: 'pending' | 'completed';
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId, commandId } = await params;

    if (!COMMAND_ID_RE.test(commandId)) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'invalid commandId',
        status: 400,
        detail: 'commandId must match /^cmd_[A-Za-z0-9_-]{1,80}$/',
      });
    }

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
    if (!auth.ok) return auth.response;

    const db = getAdminDb();
    const commandsCol = db
      .collection('sites')
      .doc(siteId)
      .collection('machines')
      .doc(machineId)
      .collection('commands');

    // Read pending then completed, serially: order stays deterministic for tests
    // and for Firestore's per-collection read budget. The agent moves a command
    // pending → completed on terminal status and writes progress markers only to
    // the completed doc.
    const pendingSnap = await commandsCol.doc('pending').get();
    const completedSnap = await commandsCol.doc('completed').get();

    const lookup = resolveCommand(commandId, pendingSnap, completedSnap);
    if (!lookup) {
      return problem({
        type: ProblemType.NotFound,
        title: 'command not found',
        status: 404,
        detail: `command ${commandId} not found on machine ${machineId}`,
      });
    }

    const cmd = lookup.data;

    // Mint a fresh signed read url every poll — the doc stores only the storage
    // path, so urls always carry a current expiry.
    let result: Record<string, unknown> | string | undefined;
    if (lookup.status === 'completed' && typeof cmd.result === 'string') {
      // reboot, shutdown and cancel answer with a sentence, not an object
      result = cmd.result;
    } else if (lookup.status === 'completed') {
      const baseResult = (cmd.result && typeof cmd.result === 'object'
        ? (cmd.result as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      result = { ...baseResult };
      const storagePath =
        typeof cmd.screenshot_path === 'string'
          ? cmd.screenshot_path
          : typeof baseResult.screenshot_path === 'string'
            ? (baseResult.screenshot_path as string)
            : typeof baseResult.storage_path === 'string'
              ? (baseResult.storage_path as string)
              : typeof cmd.storage_path === 'string'
                ? cmd.storage_path
                : null;
      if (storagePath) {
        const signed = await issueScreenshotReadUrl(storagePath);
        if (signed) {
          result.screenshot_url = signed.url;
          result.expires_at = signed.expiresAt;
        }
      }
    }

    const errorVal = cmd.error;
    const errorOut =
      lookup.status === 'failed' && typeof errorVal === 'string'
        ? errorVal
        : undefined;

    const responseBody: Record<string, unknown> = {
      ok: true,
      data: {
        commandId,
        status: lookup.status,
        ...(result && (typeof result === 'string' || Object.keys(result).length > 0) ? { result } : {}),
        ...(errorOut ? { error: errorOut } : {}),
        createdAt: timestampToIso(cmd.timestamp ?? cmd.createdAt) ?? null,
        updatedAt: timestampToIso(cmd.updatedAt ?? cmd.completedAt) ?? null,
      },
    };

    return applyAuthDeprecations(NextResponse.json(responseBody), auth.scopeCheck);
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/commands/[commandId]:GET',
    );
  }
}

/**
 * Resolve state from the two queue docs. `completed` wins over `pending`: the
 * agent writes completed and deletes pending, so a brief overlap is possible if
 * the dashboard polls mid-transition.
 */
function resolveCommand(
  commandId: string,
  pendingSnap: FirebaseFirestore.DocumentSnapshot,
  completedSnap: FirebaseFirestore.DocumentSnapshot,
): CommandLookup | null {
  const completedAll = (completedSnap.exists ? completedSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const completedEntry = completedAll?.[commandId];
  if (completedEntry && typeof completedEntry === 'object') {
    const data = completedEntry as Record<string, unknown>;
    const rawStatus = typeof data.status === 'string' ? data.status : null;
    // Non-terminal or unrecognized status means still executing — never report
    // completed with an empty result.
    if (!rawStatus || !TERMINAL_COMMAND_STATUSES.has(rawStatus)) {
      return { status: 'in_progress', data, source: 'completed' };
    }
    // Terminal. `cancelled` has no dedicated CommandStatus variant, so it maps
    // to `failed` — the agent's cancellation error then surfaces via `error`.
    const status: CommandStatus =
      rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'cancelled'
        ? 'failed'
        : 'completed';
    return { status, data, source: 'completed' };
  }

  const pendingAll = (pendingSnap.exists ? pendingSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const pendingEntry = pendingAll?.[commandId];
  if (pendingEntry && typeof pendingEntry === 'object') {
    const data = pendingEntry as Record<string, unknown>;
    // Pending always means awaiting agent pickup; progress and terminal states
    // go to the completed doc, handled above.
    return { status: 'pending', data, source: 'pending' };
  }

  return null;
}
