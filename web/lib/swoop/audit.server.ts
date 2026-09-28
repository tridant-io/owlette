/**
 * swoop's audit rows.
 *
 * Every security-relevant swoop event lands in `sites/{siteId}/audit_log`, never
 * in `sites/{siteId}/logs`: a site admin can bulk-delete the site's operational
 * feed and is also the tier that can start a control session, so the record of a
 * session cannot live where the person who started it can erase it. The logs
 * feed keeps the agent's own operational lines (`swoop_session_start` and
 * friends) and nothing else.
 *
 * A row says WHAT happened, to WHICH machine, BY WHOM. It never carries a token,
 * a key, a bundle, a dtls fingerprint or clipboard content — that is why every
 * reason here is a code matched against `REASON_PATTERN` rather than free text.
 *
 * A control grant is not a row of its own: `session_started` with `ctl: true`
 * and `MACHINE_REMOTE_CONTROL` as the row's capability IS the grant, and a
 * second row would double-count one act.
 */

import {
  generateCorrelationId,
  writeAuditEntry,
  writeAuditEntryBlocking,
  type AuditActor,
  type AuditEntryInput,
  type AuditOutcome,
  type AuditTarget,
} from '@/lib/auditLog.server';
import { Capability } from '@/lib/capabilities';

/** A reason code, never prose and never a captured value. */
const REASON_PATTERN = /^[a-z0-9_]{1,48}$/;

/** What a swoop row's `metadata.event` may say. */
export type SwoopAuditEvent =
  | 'session_started'
  | 'session_ended'
  | 'session_denied'
  | 'lease_denied'
  | 'step_up_failed';

export interface SwoopAuditBase {
  siteId: string;
  machineId: string;
  /** Absent when the refusal landed before a session existed to name. */
  sid?: string;
  actor: AuditActor;
  /** Ties this row to the wrapper's own decision row for the same call. */
  correlationId?: string;
}

function capabilityFor(ctl: boolean): Capability {
  return ctl ? Capability.MACHINE_REMOTE_CONTROL : Capability.MACHINE_REMOTE_VIEW;
}

/** The session when there is one, else the machine it was asked of. */
function swoopTarget(machineId: string, sid?: string): AuditTarget {
  return sid
    ? { kind: 'swoop_session', id: sid, machineId }
    : { kind: 'machine', id: machineId, machineId };
}

/**
 * Anything that is not a reason code is recorded as `unspecified`. A caller
 * cannot widen an audit row into a place to put a captured value.
 */
function reasonCode(reason: string | undefined): string {
  return reason !== undefined && REASON_PATTERN.test(reason) ? reason : 'unspecified';
}

function swoopEntry(args: {
  base: SwoopAuditBase;
  event: SwoopAuditEvent;
  capability: Capability;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
  denyReason?: string;
}): AuditEntryInput {
  return {
    correlationId: args.base.correlationId ?? generateCorrelationId(),
    actor: args.base.actor,
    capability: args.capability,
    target: swoopTarget(args.base.machineId, args.base.sid),
    outcome: args.outcome,
    metadata: {
      event: args.event,
      ...(args.base.sid ? { sid: args.base.sid } : {}),
      ...args.metadata,
    },
    ...(args.denyReason ? { denyReason: args.denyReason } : {}),
  };
}

/**
 * A session was granted. Awaited and fails the caller closed: a control session
 * that starts unrecorded is the one case this whole module exists to prevent.
 */
export async function recordSwoopSessionStarted(
  args: SwoopAuditBase & { sid: string; viewerId: string; ctl: boolean },
): Promise<void> {
  await writeAuditEntryBlocking(
    args.siteId,
    swoopEntry({
      base: args,
      event: 'session_started',
      capability: capabilityFor(args.ctl),
      outcome: 'allow',
      metadata: { viewerId: args.viewerId, ctl: args.ctl },
    }),
  );
}

/**
 * A session stopped. `endReason` distinguishes an operator hanging up from a
 * kill or a revocation, and `durationMs` is how long control was held.
 */
export async function recordSwoopSessionEnded(
  args: SwoopAuditBase & { sid: string; endReason: string; viewerReason?: string; durationMs?: number },
): Promise<void> {
  await writeAuditEntryBlocking(
    args.siteId,
    swoopEntry({
      base: args,
      event: 'session_ended',
      capability: Capability.MACHINE_REMOTE_VIEW,
      outcome: 'allow',
      metadata: {
        endReason: reasonCode(args.endReason),
        ...(args.viewerReason !== undefined ? { viewerReason: reasonCode(args.viewerReason) } : {}),
        ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      },
    }),
  );
}

/**
 * A refusal — a policy denial, an api-key caller, a failed step-up ceremony or a
 * lease that could not be renewed. Fire-and-forget: the response is already
 * decided and a failed deny-audit cannot change it.
 */
export function recordSwoopDenied(
  args: SwoopAuditBase & {
    event: Extract<SwoopAuditEvent, 'session_denied' | 'lease_denied' | 'step_up_failed'>;
    denyReason: string;
    ctl: boolean;
  },
): void {
  writeAuditEntry(
    args.siteId,
    swoopEntry({
      base: args,
      event: args.event,
      capability: capabilityFor(args.ctl),
      outcome: 'deny',
      denyReason: reasonCode(args.denyReason),
    }),
  );
}

/**
 * A lifecycle or denial event the streamer reported through
 * `POST /api/agent/swoop/events`.
 *
 * The actor is the REPORTER (`system:swoop_host`), never the offender: a host
 * cannot vouch for a uid whose token it has just rejected, so the refused viewer
 * is named in the metadata instead. The route owns the closed type vocabulary
 * and hands the mapped outcome and capability down.
 */
export async function recordSwoopHostEvent(args: {
  siteId: string;
  machineId: string;
  sid: string;
  event: string;
  outcome: AuditOutcome;
  capability: Capability;
  reason?: string;
  viewerId?: string;
  uid?: string;
  /** The host's own clock, kept as evidence; the row's `timestamp` is ours. */
  atMs?: number;
}): Promise<void> {
  await writeAuditEntryBlocking(args.siteId, {
    correlationId: generateCorrelationId(),
    actor: { type: 'system', name: 'swoop_host' },
    capability: args.capability,
    target: swoopTarget(args.machineId, args.sid),
    outcome: args.outcome,
    metadata: {
      event: args.event,
      sid: args.sid,
      ...(args.viewerId ? { viewerId: args.viewerId } : {}),
      ...(args.uid ? { uid: args.uid } : {}),
      ...(args.atMs !== undefined ? { hostAtMs: args.atMs } : {}),
    },
    ...(args.outcome === 'deny' ? { denyReason: reasonCode(args.reason ?? args.event) } : {}),
  });
}
