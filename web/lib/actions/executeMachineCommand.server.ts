/**
 * Action core: queue a remote command on a machine. Shared by the public route
 * and server-side callers (hoot tool dispatch via `invokeAsSystem`, jobs).
 *
 * Owns allowlist enforcement, the plan gate, the offline check, the command-id mint, the
 * `stampCommand` lifecycle write and the audit emission. Auth, capability,
 * rate-limit and idempotency belong to the wrapper — this ASSUMES it runs
 * inside an `authorizedSiteHandler` / `invokeAsSystem` frame with the actor's
 * right to the site/machine already established.
 *
 * The allowlist is deliberately narrow: everything outside it 400s with
 * `unsupported_command_type` so api-key callers can't spawn arbitrary commands.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { stampCommand } from '@/lib/commandLifecycle';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';
import { PLAN_REQUIRED_DETAIL, requireEntitlement, type PlanFlag } from '@/lib/plan.server';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * Command types this action will queue. Names must match the agent handlers in
 * `agent/src/owlette_service.py` exactly.
 */
export const ALLOWED_COMMAND_TYPES: ReadonlySet<string> = new Set<string>([
  'reboot_machine',
  'shutdown_machine',
  'cancel_reboot',
  'dismiss_reboot_pending',
  'capture_screenshot',
  'start_live_view',
  'stop_live_view',
  'restart_process',
  'start_process',
  'stop_process',
  'kill_process',
  'set_launch_mode',
  'apply_display_topology',
  'ack_display_topology',
  'enumerate_display_modes',
  'test_display_apply',
  'mcp_tool_call',
  'cancel_mcp_tool',
  'update_owlette',
]);

// the types every plan may queue (plan.md decision 7): every plan keeps
// updating, and anything already running can always be stopped.
// dismissing a pending reboot also resets the relaunch counters crash-restart needs.
const PLAN_FREE_COMMAND_TYPES: ReadonlySet<string> = new Set<string>([
  'update_owlette',
  'cancel_reboot',
  'dismiss_reboot_pending',
  'stop_live_view',
  'cancel_mcp_tool',
]);

/** the plan key a gated type needs: a tool call is hoot's, every other type is control. */
function commandPlanKey(cmdType: string): PlanFlag {
  return cmdType === 'mcp_tool_call' ? 'owlette.hoot' : 'owlette.control';
}

export interface ExecuteMachineCommandInput {
  /** Command type — must be in `ALLOWED_COMMAND_TYPES`. */
  type: string;
  /**
   * Per-type fields, merged into the command envelope as-is — the caller owns
   * validation, this does NOT re-validate. Reserved keys (see
   * `RESERVED_PAYLOAD_KEYS`) are overwritten with canonical values.
   */
  payload: Record<string, unknown>;
}

export interface ExecuteMachineCommandResult {
  commandId: string;
}

export interface ExecuteMachineCommandContext {
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

export class ExecuteMachineCommandError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  /** set on a `plan_required` refusal: the plan key it lacks. */
  readonly entitlement?: PlanFlag;
  constructor(status: number, code: string, detail: string, entitlement?: PlanFlag) {
    super(detail);
    this.name = 'ExecuteMachineCommandError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.entitlement = entitlement;
  }
}

/** Dropped from `input.payload` so a caller can't spoof queuedBy/status/lifecycle. */
const RESERVED_PAYLOAD_KEYS: ReadonlySet<string> = new Set<string>([
  'type',
  'status',
  'timestamp',
  'siteId',
  'machineId',
  'queuedBy',
  'createdAt',
  'expiresAt',
  'auditCorrelationId',
]);

function stripReservedKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (RESERVED_PAYLOAD_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface ExecuteMachineCommandOptions {
  /** Injected Firestore for tests; production omits it. */
  db?: ReturnType<typeof getAdminDb>;
  /** Override the wall-clock `now` — unit tests use this for deterministic command ids. */
  now?: () => number;
}

export async function executeMachineCommand(
  ctx: ExecuteMachineCommandContext,
  input: ExecuteMachineCommandInput,
  options: ExecuteMachineCommandOptions = {},
): Promise<ExecuteMachineCommandResult> {
  // ── input validation ────────────────────────────────────────────────────
  if (typeof ctx.siteId !== 'string' || ctx.siteId.length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'ctx.siteId is required',
    );
  }
  if (typeof ctx.machineId !== 'string' || ctx.machineId.length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'ctx.machineId is required',
    );
  }
  if (typeof input.type !== 'string' || input.type.trim().length === 0) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'field `type` is required and must be a non-empty string',
    );
  }
  const cmdType = input.type.trim();
  if (!ALLOWED_COMMAND_TYPES.has(cmdType)) {
    throw new ExecuteMachineCommandError(
      400,
      'unsupported_command_type',
      `command type '${cmdType}' is not accepted on this endpoint. ` +
        `allowed types: ${[...ALLOWED_COMMAND_TYPES].sort().join(', ')}`,
    );
  }
  if (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new ExecuteMachineCommandError(
      400,
      'validation_failed',
      'field `payload` must be an object',
    );
  }
  if (!PLAN_FREE_COMMAND_TYPES.has(cmdType)) {
    const planKey = commandPlanKey(cmdType);
    if (await requireEntitlement(ctx.siteId, planKey)) {
      throw new ExecuteMachineCommandError(402, 'plan_required', PLAN_REQUIRED_DETAIL[planKey], planKey);
    }
  }

  const safePayload = stripReservedKeys(input.payload);
  const { siteId, machineId } = ctx;
  const now = options.now ? options.now() : Date.now();

  // ── machine offline check ───────────────────────────────────────────────
  const db = options.db ?? getAdminDb();
  const machineRef = db
    .collection('sites')
    .doc(siteId)
    .collection('machines')
    .doc(machineId);
  const machineSnap = await machineRef.get();
  if (!machineSnap.exists) {
    throw new ExecuteMachineCommandError(
      404,
      'not_found',
      `machine ${machineId} not found on site ${siteId}`,
    );
  }
  const machineData = machineSnap.data() ?? {};
  if (machineData.online === false) {
    throw new ExecuteMachineCommandError(
      409,
      'machine_offline',
      `machine ${machineId} is currently offline; commands cannot be queued ` +
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

  const stamped = stampCommand(
    {
      type: cmdType,
      ...safePayload,
      siteId,
      machineId,
      timestamp: FieldValue.serverTimestamp(),
      status: 'pending',
      queuedBy: ctx.auditActor,
    },
    { auditCorrelationId: ctx.correlationId, now: () => now },
  );

  await pendingRef.set({ [commandId]: stamped }, { merge: true });

  emitMutation({
    kind: 'machine_command_dispatched',
    siteId,
    actor: ctx.auditActor,
    targetId: commandId,
    attributes: {
      commandType: cmdType,
      endpoint: `/api/sites/${siteId}/machines/${machineId}/commands`,
      method: 'POST',
      machineId,
    },
  });

  return { commandId };
}
