/**
 * one queued command's state, merged from the machine's `pending` and
 * `completed` queue documents. the public poll route and the fleet's call
 * reader share this reading, so a command reads the same through both.
 *
 * progress markers (`running`, `downloading`, `installing`) live on the
 * `completed` doc as non-terminal and surface as `in_progress`; only a status
 * `isTerminalCommandStatus` accepts resolves the command. a finished
 * screenshot gets a fresh 1-hour signed read url in `result.screenshot_url` on
 * every read; the url itself is never persisted. a registry read's values whose
 * names look like secrets are left out, as hoot leaves them out.
 */
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { isTerminalCommandStatus } from '@/lib/commandLifecycle';
import { withoutSecretRegistryValues } from '@/lib/hoot/launchChange';
import { isMachineScreenshotPath, issueScreenshotReadUrl } from '@/lib/screenshotStorage.server';

export const COMMAND_ID_RE = /^cmd_[A-Za-z0-9_-]{1,80}$/;

export type CommandStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface CommandStatusLookup {
  status: CommandStatus;
  /** the queue entry as last written. */
  data: Record<string, unknown>;
  /**
   * a completed command's result: the agent's sentence, or its object with a
   * signed `screenshot_url` and `expires_at` for a screenshot. absent when empty.
   */
  result?: Record<string, unknown> | string;
  /** a failed command's error, when the agent wrote one. */
  error?: string;
}

export async function lookupCommandStatus(
  db: Firestore,
  siteId: string,
  machineId: string,
  commandId: string,
): Promise<CommandStatusLookup | null> {
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
  if (!lookup) return null;

  const cmd = lookup.data;

  // Mint a fresh signed read url every poll — the doc stores only the storage
  // path, so urls always carry a current expiry.
  let result: Record<string, unknown> | string | undefined;
  if (lookup.status === 'completed' && typeof cmd.result === 'string') {
    // reboot, shutdown and cancel answer with a sentence, not an object; a tool
    // call answers with its json
    result = cmd.type === 'mcp_tool_call' ? withoutSecretValues(cmd.result) : cmd.result;
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
    // the agent writes this path, so only this machine's own screenshots are signed
    if (isMachineScreenshotPath(storagePath, siteId, machineId)) {
      const signed = await issueScreenshotReadUrl(storagePath);
      if (signed) {
        result.screenshot_url = signed.url;
        result.expires_at = signed.expiresAt;
      }
    }
  }

  // a cancelled hoot tool carries its reason in `error`; everything else the
  // agent cancels carries it in `result`
  const errorVal =
    typeof cmd.error === 'string' ? cmd.error : cmd.status === 'cancelled' ? cmd.result : undefined;
  const error =
    lookup.status === 'failed' && typeof errorVal === 'string' && errorVal.length > 0
      ? errorVal
      : undefined;

  return {
    status: lookup.status,
    data: cmd,
    ...(result && (typeof result === 'string' || Object.keys(result).length > 0) ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * a fielded agent lists a registry key's values, secrets included. the
 * completed entry doesn't name its tool, and `values` is only ever a registry
 * read's, so a tool call's json is read as one.
 */
function withoutSecretValues(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const kept = withoutSecretRegistryValues('registry_operation', parsed);
  return kept === parsed ? json : JSON.stringify(kept);
}

/**
 * Resolve state from the two queue docs. `completed` wins over `pending`: the
 * agent writes completed and deletes pending, so a brief overlap is possible if
 * the dashboard polls mid-transition.
 */
function resolveCommand(
  commandId: string,
  pendingSnap: DocumentSnapshot,
  completedSnap: DocumentSnapshot,
): { status: CommandStatus; data: Record<string, unknown> } | null {
  const completedAll = (completedSnap.exists ? completedSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const completedEntry = completedAll?.[commandId];
  if (completedEntry && typeof completedEntry === 'object') {
    const data = completedEntry as Record<string, unknown>;
    const rawStatus = data.status;
    // Non-terminal or unrecognized status means still executing — never report
    // completed with an empty result.
    if (!isTerminalCommandStatus(rawStatus)) {
      return { status: 'in_progress', data };
    }
    // Terminal. `cancelled` has no dedicated CommandStatus variant, so it maps
    // to `failed` — the agent's cancellation error then surfaces via `error`.
    const status: CommandStatus =
      rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'cancelled'
        ? 'failed'
        : 'completed';
    return { status, data };
  }

  const pendingAll = (pendingSnap.exists ? pendingSnap.data() : null) as
    | Record<string, unknown>
    | null;
  const pendingEntry = pendingAll?.[commandId];
  if (pendingEntry && typeof pendingEntry === 'object') {
    const data = pendingEntry as Record<string, unknown>;
    // Pending always means awaiting agent pickup; progress and terminal states
    // go to the completed doc, handled above.
    return { status: 'pending', data };
  }

  return null;
}
