/**
 * Take one user out of their live swoop sessions in a site, because their
 * authorisation to be in them just went away — removed from the site, or
 * demoted out of `MACHINE_REMOTE_CONTROL`.
 *
 * The lease already covers this: the renewal route re-checks membership, site
 * enablement and capability, so a removed member is out within one lease
 * (<= 5 min) with nothing here at all (PROTOCOL.md §10). This takes their seats
 * out of the record, and where nobody else is in the session it is the fast
 * half of the same decision — the kill path (plan.md D11) closes the window to
 * <= 2 s. It is best-effort by construction: the membership write is
 * authoritative and has already landed when this runs.
 *
 * So: never inside the caller's Firestore transaction, never awaited in a way
 * that can fail the response, and never throwing. A relay that is down costs
 * the revocation its 2 seconds, not its correctness.
 */

import type { Actor } from '@/lib/capabilities';
import logger from '@/lib/logger';
import { requestSwoopSession } from '@/lib/actions/requestSwoopSession.server';
import { recordSwoopSessionEnded } from '@/lib/swoop/audit.server';
import { listUnendedSwoopSessionsForUser, removeSwoopViewers } from '@/lib/swoop/sessionStore.server';
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

/**
 * Takes this user's seats out of every unended session they are in.
 *
 * Several viewers share a session, and the kill is sid-scoped — the protocol's
 * only per-session stop, §10 has no "evict one viewer" — so killing one with
 * someone else still in it would end it for them too. There the seats going is
 * all: the user's next renewal is refused and the host drops them within one
 * lease, and the session goes on for the rest. A session nobody else is in is
 * ended, and its streamer stopped the way the session DELETE does: the Worker
 * broadcast (authoritative, <= 2 s), and the polled `swoop_kill` command only
 * when that did not land.
 */
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
      const { machineId, sid } = session;
      // a demotion costs control and nothing else: a watch they are still
      // entitled to survives it, in this session or another.
      const seats = session.viewers.filter((viewer) => viewer.uid === args.uid && (!args.controlOnly || viewer.ctl));
      if (args.controlOnly && seats.length === 0) continue;

      // with nobody left the record ends in the same write as the seats.
      const stillIn = await removeSwoopViewers({
        siteId: args.siteId,
        machineId,
        sid,
        viewerIds: seats.map((viewer) => viewer.viewerId),
        spendContinuity: true,
        endWhenEmpty: { endReason: 'revoked' },
      });
      if (stillIn === null) continue;
      if (stillIn.length > 0) {
        if (seats.length === 0) continue;
        revokedSids.push(sid);
        for (const seat of seats) {
          await recordSwoopSessionEnded({
            siteId: args.siteId,
            machineId,
            sid,
            actor: args.actor,
            ...(args.correlationId ? { correlationId: args.correlationId } : {}),
            endReason: args.reason,
            viewerId: seat.viewerId,
            left: true,
            durationMs: Date.now() - seat.joinedAt,
          });
        }
        continue;
      }

      revokedSids.push(sid);

      const broadcast = await killSession({ siteId: args.siteId, machineId, sid }).catch(
        (): SwoopSignalResult => ({ ok: false, reason: 'unreachable' }),
      );
      // the agent's swoop_kill (4.0.1 and every earlier one) stops whatever streamer is
      // running, whatever sid it names, so a polled kill queued every time lands on the
      // next session.
      if (!broadcast.ok) {
        logger.warn('[swoop/revoke] kill broadcast failed; falling back to the polled command', {
          context: 'swoop/revoke',
          data: { siteId: args.siteId, machineId, reason: broadcast.reason },
        });
        try {
          await requestSwoopSession({
            type: 'swoop_kill',
            sid,
            siteId: args.siteId,
            machineId,
            actor: args.actor,
            auditActor: args.auditActor,
            ...(args.correlationId ? { correlationId: args.correlationId } : {}),
          });
        } catch (err) {
          logger.warn('[swoop/revoke] kill command could not be queued; the lease still ends it', {
            context: 'swoop/revoke',
            data: {
              siteId: args.siteId,
              machineId,
              err: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      await recordSwoopSessionEnded({
        siteId: args.siteId,
        machineId,
        sid,
        actor: args.actor,
        ...(args.correlationId ? { correlationId: args.correlationId } : {}),
        endReason: args.reason,
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
