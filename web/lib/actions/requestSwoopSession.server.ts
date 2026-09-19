/**
 * Action core: queue a swoop command on a machine. This is the ONLY code in the
 * product that may write a `swoop_*` command.
 *
 * The command document is a notification, not a payload. Every site member can
 * read `sites/{s}/machines/{m}/commands/pending` (`firestore.rules:303-306`), so
 * the document carries an opaque `sid` and nothing else — no bundle, no JWT, no
 * key, no TURN credential, no signalling url, no viewer id. The agent fetches
 * the session bundle from `/api/agent/swoop/bundle` over its own authenticated
 * channel (plan.md D9).
 *
 * The swoop types are deliberately ABSENT from `ALLOWED_COMMAND_TYPES`
 * (`executeMachineCommand.server.ts`) so the generic commands route cannot reach
 * them, and this module never imports `web/lib/swoop/` — sessions, tokens and
 * keys are minted by the route before it calls here.
 *
 * Auth, capability, step-up, rate-limit and idempotency belong to the wrapper —
 * this ASSUMES it runs inside an `authorizedSiteHandler` frame with the actor's
 * right to the site/machine already established.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';
import { FieldValue } from 'firebase-admin/firestore';

/** Command types this action will queue. Must match the agent handlers in `agent/src/swoop_commands.py`. */
export const SWOOP_COMMAND_TYPES = [
  'swoop_session_requested',
  'swoop_kill',
  'swoop_refresh',
] as const;

export type SwoopCommandType = (typeof SWOOP_COMMAND_TYPES)[number];

const SWOOP_COMMAND_TYPE_SET: ReadonlySet<string> = new Set<string>(SWOOP_COMMAND_TYPES);

/**
 * Per-type sid rule. `swoop_refresh` fires on a site enablement toggle, where no
 * session exists to name; `swoop_kill` without a sid means "kill whatever is
 * running".
 */
const SID_RULE: Readonly<Record<SwoopCommandType, 'required' | 'optional' | 'forbidden'>> = {
  swoop_session_requested: 'required',
  swoop_kill: 'optional',
  swoop_refresh: 'forbidden',
};

/**
 * A sid is an opaque handle. The charset is narrow on purpose: it admits uuid /
 * nanoid / base64url ids but no `.`, `/`, `:` or whitespace, so a url, a JWT or
 * a serialised blob cannot be smuggled into the member-readable document through
 * the one field that is allowed in it.
 */
const SID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RequestSwoopSessionInput {
  /** Command type — one of `SWOOP_COMMAND_TYPES`. */
  type: SwoopCommandType;
  /** Opaque session handle. Required, optional or forbidden per `SID_RULE`. */
  sid?: string;
  siteId: string;
  /** Target machine within `siteId`. */
  machineId: string;
  /** Acting principal. Kept as a hook for per-actor branching; unread today. */
  actor: Actor;
  /** Audit-actor descriptor: `user:<uid>`, `apiKey:<keyId>` or `system:<name>`. */
  auditActor: string;
  /**
   * Stamped into the envelope so the agent write-back correlates with the
   * originating audit row.
   */
  correlationId?: string;
}

export interface RequestSwoopSessionResult {
  commandId: string;
}

export interface RequestSwoopSessionOptions {
  /** Injected Firestore for tests; production omits it. */
  db?: ReturnType<typeof getAdminDb>;
  /** Override the wall-clock `now` — unit tests use this for deterministic command ids. */
  now?: () => number;
}

export class RequestSwoopSessionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  constructor(status: number, code: string, detail: string) {
    super(detail);
    this.name = 'RequestSwoopSessionError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export async function requestSwoopSession(
  input: RequestSwoopSessionInput,
  options: RequestSwoopSessionOptions = {},
): Promise<RequestSwoopSessionResult> {
  // ── input validation ────────────────────────────────────────────────────
  if (typeof input.siteId !== 'string' || input.siteId.length === 0) {
    throw new RequestSwoopSessionError(400, 'validation_failed', 'siteId is required');
  }
  if (typeof input.machineId !== 'string' || input.machineId.length === 0) {
    throw new RequestSwoopSessionError(400, 'validation_failed', 'machineId is required');
  }
  if (typeof input.type !== 'string' || !SWOOP_COMMAND_TYPE_SET.has(input.type)) {
    throw new RequestSwoopSessionError(
      400,
      'unsupported_command_type',
      `command type '${String(input.type)}' is not a swoop command. ` +
        `allowed types: ${[...SWOOP_COMMAND_TYPES].sort().join(', ')}`,
    );
  }
  const cmdType = input.type;

  const rule = SID_RULE[cmdType];
  const sid = input.sid;
  if (sid === undefined) {
    if (rule === 'required') {
      throw new RequestSwoopSessionError(
        400,
        'validation_failed',
        `field \`sid\` is required for ${cmdType}`,
      );
    }
  } else {
    if (rule === 'forbidden') {
      throw new RequestSwoopSessionError(
        400,
        'validation_failed',
        `field \`sid\` must not be sent for ${cmdType}`,
      );
    }
    if (typeof sid !== 'string' || !SID_PATTERN.test(sid)) {
      throw new RequestSwoopSessionError(
        400,
        'validation_failed',
        'field `sid` must be an opaque id of 1-128 characters from [A-Za-z0-9_-]',
      );
    }
  }

  const { siteId, machineId } = input;
  const now = options.now ? options.now() : Date.now();

  // ── machine doc gating ──────────────────────────────────────────────────
  const db = options.db ?? getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new RequestSwoopSessionError(
      404,
      'not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }
  const machineData = machineSnap.data() ?? {};
  // a kill is queued even for an offline machine: when it comes back it may
  // still be running a streamer from before it dropped, and the polled command
  // is the last-resort path that stops it (plan.md D11).
  if (machineData.online === false && cmdType !== 'swoop_kill') {
    throw new RequestSwoopSessionError(
      409,
      'machine_offline',
      `machine ${machineId} is currently offline; ${cmdType} cannot be queued ` +
        `until it reconnects`,
    );
  }

  // ── write command to pending queue ──────────────────────────────────────
  const commandId = `cmd_${now.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const pendingRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId)
    .collection('commands')
    .doc('pending');

  // the whole contract: type, sid where the type carries one, the canonical
  // envelope, and stampCommand's lifecycle fields. nothing else may be added
  // here — site members read this document.
  const stamped = stampCommand(
    {
      type: cmdType,
      ...(sid === undefined ? {} : { sid }),
      siteId,
      machineId,
      timestamp: FieldValue.serverTimestamp(),
      status: 'pending',
      queuedBy: input.auditActor,
    },
    { auditCorrelationId: input.correlationId, now: () => now },
  );

  await pendingRef.set({ [commandId]: stamped }, { merge: true });

  // endpoint/method stay off the attributes: swoop commands are queued from
  // three different routes and the `authorizedSiteHandler` wrapper already
  // writes a per-call audit row carrying the real one.
  emitMutation({
    kind: 'machine_command_dispatched',
    siteId,
    actor: input.auditActor,
    targetId: commandId,
    attributes: {
      commandType: cmdType,
      machineId,
    },
  });

  return { commandId };
}
