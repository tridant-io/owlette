/**
 * POST /api/agent/swoop/events — host-side lifecycle and refusal events into
 * `sites/{siteId}/audit_log`.
 *
 * The streamer is the only place several of these can be observed at all: a
 * rejected viewer jwt, a `fp` that does not match the offer, a watch-only
 * viewer sending input. Site admins can bulk-delete `sites/{siteId}/logs`, so
 * these go to the audit log, which they cannot.
 *
 * The write is awaited and a failure is a 503 — an audit-only endpoint that
 * swallows its own write failure records nothing and says it did.
 *
 * Three of the lifecycle events are also mirrored onto the session record
 * (`mirrorSessionRecord`), because the streamer is the only thing that sees
 * them happen. That mirror runs AFTER the audit write and never changes the
 * response: the audit row is what this endpoint promises.
 *
 * Events carry a type, a reason code and ids. No token, no key, no fingerprint,
 * no clipboard content ever reaches this route or a log line.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { problemValidation } from '@/lib/apiErrors';
import type { AuditOutcome } from '@/lib/auditLog.server';
import { Capability } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { recordSwoopHostEvent } from '@/lib/swoop/audit.server';
import {
  endSwoopSession,
  getSwoopSession,
  removeSwoopViewer,
  setSwoopSessionState,
  type SwoopSessionEndReason,
} from '@/lib/swoop/sessionStore.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { NO_STORE, SWOOP_ID_PATTERN, requireSwoopAgent } from '../_shared';

/** One batch is what a streamer accumulates between flushes, not a firehose. */
const MAX_EVENTS = 20;

/** A reason code, never prose and never a value. */
const REASON_PATTERN = /^[a-z0-9_]{1,48}$/;

/**
 * The vocabulary, and what each event means to the audit trail. Anything else
 * is a 400: an open `type` field would let the host write arbitrary rows.
 *
 * It is the same closed set as `ipc::HostEventKind` in the streamer and the
 * `host_event` table in `agent/swoop/PROTOCOL.md` §6 — the agent copies the
 * streamer's `kind` straight into `type`, so a name in one and not the other
 * is a 400 for the whole batch.
 */
const EVENT_KINDS = {
  session_started: { outcome: 'allow', capability: Capability.MACHINE_REMOTE_VIEW },
  session_ended: { outcome: 'allow', capability: Capability.MACHINE_REMOTE_VIEW },
  viewer_joined: { outcome: 'allow', capability: Capability.MACHINE_REMOTE_VIEW },
  viewer_left: { outcome: 'allow', capability: Capability.MACHINE_REMOTE_VIEW },
  clipboard_audit: { outcome: 'allow', capability: Capability.MACHINE_REMOTE_CONTROL },
  jwt_rejected: { outcome: 'deny', capability: Capability.MACHINE_REMOTE_VIEW },
  fp_mismatch: { outcome: 'deny', capability: Capability.MACHINE_REMOTE_VIEW },
  lease_expired: { outcome: 'deny', capability: Capability.MACHINE_REMOTE_VIEW },
  /** An admission limit — viewer count or join rate — turned a join away. */
  join_refused: { outcome: 'deny', capability: Capability.MACHINE_REMOTE_VIEW },
  input_not_permitted: { outcome: 'deny', capability: Capability.MACHINE_REMOTE_CONTROL },
} as const satisfies Record<string, { outcome: AuditOutcome; capability: Capability }>;

type SwoopEventType = keyof typeof EVENT_KINDS;

interface SwoopEvent {
  type: SwoopEventType;
  sid: string;
  reason?: string;
  viewerId?: string;
  uid?: string;
  /** The host's own clock, kept as evidence; the row's `timestamp` is ours. */
  atMs?: number;
}

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' && SWOOP_ID_PATTERN.test(value) ? value : null;
}

/** Returns null for anything malformed — the whole batch is then refused. */
function parseEvent(raw: unknown): SwoopEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { type, sid, reason, viewerId, uid, atMs } = raw as Record<string, unknown>;
  // hasOwnProperty, not `in`: `constructor` satisfies the vocabulary check on
  // the prototype chain and would reach the audit write with no outcome at all.
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_KINDS, type)) {
    return null;
  }
  if (typeof sid !== 'string' || !SWOOP_ID_PATTERN.test(sid)) return null;

  if (reason !== undefined && (typeof reason !== 'string' || !REASON_PATTERN.test(reason))) {
    return null;
  }
  const viewer = optionalId(viewerId);
  const actingUid = optionalId(uid);
  if (viewer === null || actingUid === null) return null;
  if (atMs !== undefined && (typeof atMs !== 'number' || !Number.isFinite(atMs))) return null;

  return {
    type: type as SwoopEventType,
    sid,
    ...(reason !== undefined ? { reason } : {}),
    ...(viewer !== undefined ? { viewerId: viewer } : {}),
    ...(actingUid !== undefined ? { uid: actingUid } : {}),
    ...(atMs !== undefined ? { atMs } : {}),
  };
}

export const POST = withRateLimit(
  async (request: NextRequest): Promise<NextResponse> => {
    try {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return problemValidation('request body is not valid json');
      }
      if (typeof raw !== 'object' || raw === null) {
        return problemValidation('siteId, machineId and events are required');
      }

      const { siteId, machineId, events } = raw as Record<string, unknown>;
      if (typeof siteId !== 'string' || typeof machineId !== 'string') {
        return problemValidation('siteId and machineId are required');
      }
      if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) {
        return problemValidation(`events must hold between 1 and ${MAX_EVENTS} entries`);
      }

      const parsed: SwoopEvent[] = [];
      for (const entry of events) {
        const event = parseEvent(entry);
        if (!event) return problemValidation('events contains an unrecognised entry');
        parsed.push(event);
      }

      const auth = await requireSwoopAgent(request, 'write', { siteId, machineId });
      if (!auth.ok) return auth.response;

      try {
        await recordEvents(auth.agent.siteId, auth.agent.machineId, parsed);
      } catch (error: unknown) {
        return apiError(error, 'agent/swoop/events', 503);
      }

      return NextResponse.json({ recorded: parsed.length }, { status: 202, headers: NO_STORE });
    } catch (error: unknown) {
      return apiError(error, 'agent/swoop/events');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);

/** The events that move the session record, not just the audit trail. */
const MIRRORED_EVENTS = new Set<SwoopEventType>([
  'session_started',
  'viewer_left',
  'session_ended',
]);

type MirroredEvent = SwoopEvent & {
  type: 'session_started' | 'viewer_left' | 'session_ended';
};

function isMirrored(event: SwoopEvent): event is MirroredEvent {
  return MIRRORED_EVENTS.has(event.type);
}

/**
 * The streamer's own `exiting.reason` vocabulary (PROTOCOL.md §6) as the
 * reason the record keeps. A stop it named nothing recognisable for is
 * `host_exit` — "the streamer said it ended" — rather than a reason invented
 * on its behalf.
 */
const HOST_END_REASONS = new Map<string, SwoopSessionEndReason>([
  ['kill', 'killed'],
  ['idle', 'idle'],
  ['session_cap', 'session_cap'],
  ['signal_lost', 'signal_lost'],
  ['error', 'error'],
]);

/**
 * Mirror one host lifecycle event onto `swoop_sessions/{sid}`.
 *
 * These three transitions have no other witness: without this the record never
 * leaves `pending`, a viewer who left stays in `viewers[]`, and a finished
 * session reads as live to the revocation sweep for as long as the document
 * exists.
 *
 * Two things it will not do. It never re-creates a session — the store merges,
 * so an event naming a swept or foreign sid would otherwise write a fresh
 * document, and a host could grow the collection one event at a time. And it
 * never touches an already-ended record: whatever closed it — a kill, a
 * revocation, the cap — recorded why, and a late `session_ended` must not
 * restate it.
 */
async function mirrorSessionRecord(
  siteId: string,
  machineId: string,
  event: MirroredEvent,
): Promise<void> {
  const session = await getSwoopSession(siteId, machineId, event.sid);
  if (!session || session.state === 'ended') return;

  switch (event.type) {
    case 'session_started':
      await setSwoopSessionState(siteId, machineId, event.sid, 'live');
      return;
    case 'viewer_left':
      if (event.viewerId) {
        await removeSwoopViewer({ siteId, machineId, sid: event.sid, viewerId: event.viewerId });
      }
      return;
    case 'session_ended':
      await endSwoopSession({
        siteId,
        machineId,
        sid: event.sid,
        // A Map, not an object: `reason` passes REASON_PATTERN, so `constructor`
        // is a legal value and a plain lookup would answer with Object itself.
        endReason: (event.reason && HOST_END_REASONS.get(event.reason)) || 'host_exit',
      });
      return;
  }
}

async function recordEvents(
  siteId: string,
  machineId: string,
  events: readonly SwoopEvent[],
): Promise<void> {
  for (const event of events) {
    const kind = EVENT_KINDS[event.type];
    // The row shape — the `swoop_host` actor, the session target and the
    // reason-code guard — belongs to `lib/swoop/audit.server.ts`; this route
    // owns only the vocabulary it will accept off the wire.
    await recordSwoopHostEvent({
      siteId,
      machineId,
      sid: event.sid,
      event: event.type,
      outcome: kind.outcome,
      capability: kind.capability,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      ...(event.viewerId ? { viewerId: event.viewerId } : {}),
      ...(event.uid ? { uid: event.uid } : {}),
      ...(event.atMs !== undefined ? { atMs: event.atMs } : {}),
    });

    // After the audit row and never fatal. The agent re-posts a batch it got a
    // 503 for, so failing here would duplicate audit rows to fix a record the
    // 12-hour cap and the retention sweep both close anyway.
    if (isMirrored(event)) {
      try {
        await mirrorSessionRecord(siteId, machineId, event);
      } catch (error: unknown) {
        logger.warn('[swoop/events] session record could not be mirrored', {
          context: 'swoop/events',
          data: {
            siteId,
            machineId,
            event: event.type,
            err: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
}
