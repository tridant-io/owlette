/**
 * End one person's live swoop sessions. A revocation ends every one they are
 * in, in a site, because their authorisation to be in them just went away —
 * removed from the site, or demoted out of `MACHINE_REMOTE_CONTROL`. A kick
 * (`swoop/sessions/{sid}/kick`) ends one, because a site owner or admin took
 * them out of it.
 *
 * The lease already covers a revocation: the renewal route re-checks
 * membership, site enablement and capability, so a removed member is out within
 * one lease (<= 5 min) with nothing here at all (PROTOCOL.md §10). This is the
 * fast half of the same decision — the kill path (plan.md D11) closes the window
 * to <= 2 s — and it is best-effort by construction: the membership write is
 * authoritative and has already landed when this runs.
 *
 * So the sweep is never inside the caller's Firestore transaction, never
 * awaited in a way that can fail the response, and never throws. A relay that
 * is down costs the revocation its 2 seconds, not its correctness. A kick is the
 * request itself, so its end may throw, and the kick route answers it.
 */

import type { Actor } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import { recordSwoopSessionEnded } from '@/lib/swoop/audit.server';
import {
  endSwoopSession,
  listUnendedSwoopSessionsForUser,
  type SwoopSession,
} from '@/lib/swoop/sessionStore.server';
import { killSession, type SwoopSignalResult } from '@/lib/swoop/signal.server';

export interface RevokeSwoopSessionsArgs {
  siteId: string;
  uid: string;
  /** Whoever made the membership change. They ended these sessions. */
  actor: Actor;
  /** `user:<uid>` / `apiKey:<keyId>`, for the command envelope. */
  auditActor: string;
  /** Why, for the audit row. A reason code, never prose. */
  reason: 'member_removed' | 'role_changed' | 'swoop_changed';
  /**
   * Only sessions in which this user holds CONTROL. A demotion costs them
   * `MACHINE_REMOTE_CONTROL` and nothing else, so a watch they are still
   * entitled to must survive it.
   */
  controlOnly?: boolean;
  /** Stamped on the command envelope so the agent's write-back correlates. */
  correlationId?: string;
}

export interface RevokeSwoopSessionsResult {
  revokedSids: string[];
}

export interface EndSwoopSessionForUserArgs {
  session: SwoopSession;
  /** whom it is ended for: the record names them. */
  uid: string;
  endReason: 'revoked' | 'kicked';
  /** whoever ended it. */
  actor: Actor;
  /** `user:<uid>` / `apiKey:<keyId>`, for the command envelope. */
  auditActor: string;
  /** stamped on the command envelope so the agent's write-back correlates. */
  correlationId?: string;
}

/**
 * Ends one session for one person, then stops the streamer the way the session
 * DELETE does: the Worker broadcast (authoritative, <= 2 s), and the polled
 * `swoop_kill` command only when that did not land.
 *
 * Several viewers share a session, and the kill is sid-scoped — the protocol's
 * only per-session stop, §10 has no "evict one viewer" — so it ends for
 * everyone in it. Taking out the person's seat alone would leave them in it, in
 * control if they held it, until the host drops them a lease later. So the
 * record names whom it was ended for (`endedFor`), and everyone in it starts
 * the next session on their own, where the api decides what each may do now:
 * the person removed is refused, the person demoted watches, and the person
 * kicked stops on the record's word. Step-up windows are untouched, which only
 * the kill route closes.
 *
 * Throws when the record cannot be ended; a stop path that fails is logged, and
 * the lease still ends the streamer. The audit row is the caller's: a kick
 * writes it after the stop and answers its failure, a revocation counts the
 * session as ended before writing it.
 */
export async function endSwoopSessionForUser(args: EndSwoopSessionForUserArgs): Promise<void> {
  const { siteId, machineId, sid } = args.session;

  await endSwoopSession({
    siteId,
    machineId,
    sid,
    endReason: args.endReason,
    endedFor: args.uid,
  });

  const broadcast = await killSession({ siteId, machineId, sid }).catch(
    (): SwoopSignalResult => ({ ok: false, reason: 'unreachable' }),
  );
  // the agent's swoop_kill (4.0.1 and every earlier one) stops whatever streamer is
  // running, whatever sid it names, so a polled kill queued every time lands on the
  // next session.
  if (!broadcast.ok) {
    logger.warn('[swoop/end-for-user] kill broadcast failed; falling back to the polled command', {
      context: 'swoop/end-for-user',
      data: { siteId, machineId, endReason: args.endReason, reason: broadcast.reason },
    });
    try {
      await requestSwoopSession({
        type: 'swoop_kill',
        sid,
        siteId,
        machineId,
        actor: args.actor,
        auditActor: args.auditActor,
        ...(args.correlationId ? { correlationId: args.correlationId } : {}),
      });
    } catch (err) {
      logger.warn('[swoop/end-for-user] kill command could not be queued; the lease still ends it', {
        context: 'swoop/end-for-user',
        data: {
          siteId,
          machineId,
          endReason: args.endReason,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

/** Ends every unended session this user holds a seat in (`endSwoopSessionForUser`). */
export async function revokeSwoopSessionsForUser(
  args: RevokeSwoopSessionsArgs,
): Promise<RevokeSwoopSessionsResult> {
  const revokedSids: string[] = [];
  try {
    const sessions = await listUnendedSwoopSessionsForUser({
      siteId: args.siteId,
      uid: args.uid,
    });

    for (const session of sessions) {
      // a session they started and left goes on without them, and a demotion
      // costs control and nothing else: a watch they are still entitled to survives it.
      const seated = session.viewers.some((viewer) => viewer.uid === args.uid && (!args.controlOnly || viewer.ctl));
      if (!seated) continue;

      await endSwoopSessionForUser({
        session,
        uid: args.uid,
        endReason: 'revoked',
        actor: args.actor,
        auditActor: args.auditActor,
        correlationId: args.correlationId,
      });
      revokedSids.push(session.sid);

      await recordSwoopSessionEnded({
        siteId: args.siteId,
        machineId: session.machineId,
        sid: session.sid,
        actor: args.actor,
        ...(args.correlationId ? { correlationId: args.correlationId } : {}),
        endReason: args.reason,
        endedFor: args.uid,
        durationMs: Date.now() - session.startedAt,
      });
    }
  } catch (err) {
    // The membership write is already done and is what actually removes the
    // access; a failure here costs the <= 2 s path, not the revocation.
    logger.warn('[swoop/revoke] session revocation swept incompletely', {
      context: 'swoop/revoke',
      data: {
        siteId: args.siteId,
        uid: args.uid,
        revoked: revokedSids.length,
        err: err instanceof Error ? err.message : String(err),
      },
    });
  }
  return { revokedSids };
}
