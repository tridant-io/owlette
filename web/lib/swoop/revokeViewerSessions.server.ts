/**
 * End one user's live swoop sessions in a site, because their authorisation to
 * be in them just went away — removed from the site, or demoted out of
 * `MACHINE_REMOTE_CONTROL`.
 *
 * The lease already covers this: the renewal route re-checks membership, site
 * enablement and capability, so a removed member is out within one lease
 * (<= 5 min) with nothing here at all (PROTOCOL.md §10). This is the fast half
 * of the same decision — the kill path (plan.md D11) closes the window to
 * <= 2 s — and it is best-effort by construction: the membership write is
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
import {
  endSwoopSession,
  listUnendedSwoopSessionsForUser,
  type SwoopSession,
} from '@/lib/swoop/sessionStore.server';
import { killSession } from '@/lib/swoop/signal.server';

export interface RevokeSwoopSessionsArgs {
  siteId: string;
  uid: string;
  /** Whoever made the membership change. They ended these sessions. */
  actor: Actor;
  /** `user:<uid>` / `apiKey:<keyId>`, for the command envelope. */
  auditActor: string;
  /** Why, for the audit row. A reason code, never prose. */
  reason: 'member_removed' | 'role_changed';
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

function holdsControl(session: SwoopSession, uid: string): boolean {
  return session.viewers.some((viewer) => viewer.uid === uid && viewer.ctl);
}

/**
 * Ends every unended session this user is in, then stops the streamer over the
 * same two independent paths the session DELETE uses: the Worker broadcast
 * (authoritative, <= 2 s) and the polled `swoop_kill` command (last resort).
 *
 * The kill is sid-scoped, so a session with other viewers in it ends for them
 * too. That is the protocol's only per-session stop — §10 has no "evict one
 * viewer" — and ending a stream is never the dangerous direction.
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
    const targets = args.controlOnly
      ? sessions.filter((session) => holdsControl(session, args.uid))
      : sessions;

    for (const session of targets) {
      const { machineId, sid } = session;
      await endSwoopSession({
        siteId: args.siteId,
        machineId,
        sid,
        endReason: 'revoked',
      });
      revokedSids.push(sid);

      const [killed, queued] = await Promise.allSettled([
        killSession({ siteId: args.siteId, machineId, sid }),
        requestSwoopSession({
          type: 'swoop_kill',
          sid,
          siteId: args.siteId,
          machineId,
          actor: args.actor,
          auditActor: args.auditActor,
          ...(args.correlationId ? { correlationId: args.correlationId } : {}),
        }),
      ]);
      if (killed.status === 'fulfilled' && !killed.value.ok) {
        logger.warn('[swoop/revoke] kill broadcast failed; the lease still ends it', {
          context: 'swoop/revoke',
          data: { siteId: args.siteId, machineId, reason: killed.value.reason },
        });
      }
      if (queued.status === 'rejected') {
        logger.warn('[swoop/revoke] kill command could not be queued', {
          context: 'swoop/revoke',
          data: {
            siteId: args.siteId,
            machineId,
            err:
              queued.reason instanceof Error ? queued.reason.message : String(queued.reason),
          },
        });
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
