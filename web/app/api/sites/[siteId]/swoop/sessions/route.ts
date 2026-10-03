/**
 * GET /api/sites/{siteId}/swoop/sessions — every swoop session in the site that
 * someone can still be in, pending and live, oldest first, with the people in
 * it. The admin swoop page lists it, and kills from it through the machine's
 * own `swoop/kill` route with the session's sid.
 *
 * The session records are server-only (no rule reaches them), so this is how a
 * site admin sees them at all. They are read through the store like every other
 * read of the collection; only the viewer names come from here, in one `getAll`
 * over `users`, the members-route pattern. A viewer whose account is gone keeps
 * their row with null names: the seat is still taken, whoever held it.
 *
 * Api keys are refused like on every other swoop route. swoop is a
 * human-in-the-loop surface, and who is watching which machine right now is
 * not something a key has any business knowing.
 */

import { NextResponse } from 'next/server';
import { problemFromError } from '@/lib/apiErrors';
import { applyAuthDeprecations } from '@/app/api/_shared';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { listLiveSwoopSessionsForSite, type SwoopSession } from '@/lib/swoop/sessionStore.server';
import { apiKeyRefusal } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/_shared';

interface SiteSwoopSessionsParams {
  [key: string]: string | undefined;
  siteId: string;
}

interface UserDoc {
  email?: unknown;
  displayName?: unknown;
  deletedAt?: unknown;
}

interface ViewerName {
  email: string | null;
  displayName: string | null;
}

const NO_NAME: ViewerName = { email: null, displayName: null };

/**
 * One read for every distinct viewer in the site, however many sessions they
 * are in. A missing or soft-deleted account is left out of the map, so its
 * viewer answers `NO_NAME`.
 */
async function viewerNames(sessions: SwoopSession[]): Promise<Map<string, ViewerName>> {
  const names = new Map<string, ViewerName>();
  // the store reads a viewer row with no uid as '', which is no document path.
  const uids = [
    ...new Set(sessions.flatMap((session) => session.viewers.map((viewer) => viewer.uid))),
  ].filter((uid) => uid !== '');
  if (uids.length === 0) return names;

  const db = getAdminDb();
  const snaps = await db.getAll(...uids.map((uid) => db.collection('users').doc(uid)));
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    const data = (snap.data() ?? {}) as UserDoc;
    if (typeof data.deletedAt === 'number') return;
    names.set(uids[i], {
      email: typeof data.email === 'string' ? data.email : null,
      displayName: typeof data.displayName === 'string' ? data.displayName : null,
    });
  });
  return names;
}

const listHandler: SiteRouteHandler<SiteSwoopSessionsParams> = async (_request, ctx) => {
  try {
    const keyRefusal = apiKeyRefusal(ctx);
    if (keyRefusal) return keyRefusal;

    const sessions = await listLiveSwoopSessionsForSite({ siteId: ctx.siteId });
    const names = await viewerNames(sessions);

    const body = sessions
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((session) => ({
        sid: session.sid,
        machineId: session.machineId,
        state: session.state,
        startedAt: session.startedAt,
        viewers: session.viewers.map((viewer) => ({
          uid: viewer.uid,
          ...(names.get(viewer.uid) ?? NO_NAME),
          ctl: viewer.ctl,
          joinedAt: viewer.joinedAt,
        })),
      }));

    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: { sessions: body } }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/swoop/sessions:GET');
  }
};

/**
 * Site admin/owner. The page this feeds exists to end other people's sessions,
 * so seeing them takes the same capability the kill does.
 */
export const GET = authorizedSiteHandler<SiteSwoopSessionsParams>({
  capability: Capability.MACHINE_REMOTE_CONTROL,
  siteIdParam: 'path',
  apiKeyPermission: 'read',
})(listHandler);
