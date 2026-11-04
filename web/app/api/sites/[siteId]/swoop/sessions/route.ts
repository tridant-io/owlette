/**
 * GET /api/sites/{siteId}/swoop/sessions — every swoop session in the site that
 * someone can still be in, pending and live, oldest first, with the people in
 * it. The admin swoop page lists it, and kills from it through the machine's
 * own `swoop/kill` route with the session's sid.
 *
 * The session records are server-only (no rule reaches them), so this is how a
 * site admin sees them at all. They are read through the store like every other
 * read of the collection; the viewer names come from `viewerNames`, one read
 * for every person in the site's sessions. A viewer whose account is gone keeps
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
import { listLiveSwoopSessionsForSite } from '@/lib/swoop/sessionStore.server';
import { NO_NAME, viewerNames } from '@/lib/swoop/viewerNames.server';
import { apiKeyRefusal } from '@/app/api/sites/[siteId]/machines/[machineId]/swoop/_shared';

interface SiteSwoopSessionsParams {
  [key: string]: string | undefined;
  siteId: string;
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
