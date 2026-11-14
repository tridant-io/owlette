/**
 * Command lifecycle helpers.
 *
 * The agent listens to ONE document,
 * `sites/{siteId}/machines/{machineId}/commands/pending`, whose fields are a
 * map of `{ [commandId]: { type, status, ... } }`; server-issued commands are
 * stamped and merged into it by command id.
 *
 * `createdAt` uses `FieldValue.serverTimestamp()` — legal in nested map fields
 * under a top-level set/update, forbidden only inside array elements. The 24h
 * `expiresAt` is a wall-clock `Timestamp` so field-level reads need no sentinel
 * resolver.
 *
 * `writeCommandFanOut` map-merges one command across n machines. Writes to
 * different machines are independent; same-machine writes merge per Firestore
 * field semantics, and ids can't collide (prefix carries `Date.now()` + id).
 *
 * Expiry cleanup is NOT implemented — see
 * `dev/active/security-boundary-migration/reference/command-lifecycle.md`.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';

/** 24h expiry — matches the agent's longest-running command allowance. */
export const COMMAND_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * the `commands/completed` statuses that end a command. the agent also writes
 * `running` when it picks a command up and, for installs, updates and
 * uninstalls, progress statuses (`closing_processes`, `downloading`,
 * `installing`, `uninstalling`): none of those is the answer. no agent writes
 * `error`; it stays in the set because the readers here always took it as one.
 */
const TERMINAL_COMMAND_STATUSES: ReadonlySet<unknown> = new Set([
  'completed',
  'failed',
  'cancelled',
  'error',
]);

export function isTerminalCommandStatus(status: unknown): boolean {
  return TERMINAL_COMMAND_STATUSES.has(status);
}

/**
 * One entry in the `pending` map. Untyped on purpose: every command type has
 * its own payload and these helpers are payload-agnostic — strict typing lives
 * in each action core (e.g. `executeMachineCommand`).
 */
export type CommandData = Record<string, unknown>;

/** Post-`stampCommand`: lifecycle fields guaranteed, correlation id if passed. */
export interface StampedCommandData extends CommandData {
  createdAt: FieldValue;
  expiresAt: Timestamp;
  auditCorrelationId?: string;
}

/**
 * Per-machine fan-out result. `commandId` is
 * `${commandIdPrefix}_${machineId}_${ts}`; `error` carries the message only,
 * no stack, to keep the audit log compact.
 */
export interface FanOutResult {
  machineId: string;
  ok: boolean;
  commandId?: string;
  error?: string;
}

export interface StampCommandOptions {
  /** Optional correlation id from `authorizedHandler`/`systemInvoker`. */
  auditCorrelationId?: string;
  /** Override the wall-clock `now` — unit tests use this for determinism. */
  now?: () => number;
}

/**
 * Add lifecycle fields, returning a fresh object. Any pre-existing
 * `createdAt`/`expiresAt` is OVERWRITTEN — this helper is authoritative.
 */
export function stampCommand(
  commandData: CommandData,
  options: StampCommandOptions = {},
): StampedCommandData {
  const now = options.now ? options.now() : Date.now();
  const stamped: StampedCommandData = {
    ...commandData,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(now + COMMAND_EXPIRY_MS),
  };
  if (options.auditCorrelationId) {
    stamped.auditCorrelationId = options.auditCorrelationId;
  }
  return stamped;
}

export interface WriteCommandFanOutOptions extends StampCommandOptions {
  /** Injected Firestore for tests; production omits it. */
  db?: ReturnType<typeof getAdminDb>;
}

/**
 * Map-merge one command across n machines under
 * `${commandIdPrefix}_${sanitizedMachineId}_${ts}` — the legacy hook-side
 * scheme, so the agent's listener sees the same key shape as before.
 * One result per machine; a rejected write does not abort the others.
 */
export async function writeCommandFanOut(
  siteId: string,
  machineIds: readonly string[],
  commandIdPrefix: string,
  commandData: CommandData,
  options: WriteCommandFanOutOptions = {},
): Promise<FanOutResult[]> {
  if (!siteId) throw new Error('writeCommandFanOut: siteId is required');
  if (!commandIdPrefix) throw new Error('writeCommandFanOut: commandIdPrefix is required');

  const db = options.db ?? getAdminDb();
  const stamped = stampCommand(commandData, {
    auditCorrelationId: options.auditCorrelationId,
    now: options.now,
  });
  // One shared timestamp ties every per-machine id to the same logical batch,
  // which the reconciler relies on when replaying.
  const batchTs = options.now ? options.now() : Date.now();

  return Promise.all(
    machineIds.map<Promise<FanOutResult>>(async (machineId) => {
      const sanitizedMachineId = machineId.replace(/-/g, '_');
      const commandId = `${commandIdPrefix}_${sanitizedMachineId}_${batchTs}`;
      try {
        const pendingRef = db
          .collection('sites')
          .doc(siteId)
          .collection('machines')
          .doc(machineId)
          .collection('commands')
          .doc('pending');
        await pendingRef.set({ [commandId]: stamped }, { merge: true });
        return { machineId, ok: true, commandId };
      } catch (err) {
        return {
          machineId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}
