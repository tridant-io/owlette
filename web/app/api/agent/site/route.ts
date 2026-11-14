import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { withRateLimit } from '@/lib/withRateLimit';
import { ROOST_ENABLED_FIELD } from '@/lib/roostKillSwitch';
import { apiError } from '@/lib/apiErrorResponse';
import { problemForbidden, problemNotFound, problemUnauthorized } from '@/lib/apiErrors';

/**
 * GET /api/agent/site — the metadata an agent is allowed to learn about the site
 * it is paired to: the display name, so the desktop app can say "TEC-A4D is
 * connected to TEC", and the schedule timezone when — and only when — the site
 * has opted into site time. Read by `firebase_client._fetch_site_metadata` and
 * cached agent-side.
 *
 * Auth: `Authorization: Bearer <agent-firebase-id-token>`. Exists because
 * firestore.rules grants an agent its machine subtree only
 * (`agentCanAccessMachine`), so a direct read of `sites/{siteId}` 403s.
 *
 * 200 `{ name: string | null, timezone: string | null, roostEnabled: boolean | null,
 * keepAwake: boolean }`.
 * `name` is null when the site has no name, so the caller falls back to the id
 * rather than rendering "null". 401 missing/invalid bearer, 403 non-agent token
 * or no `site_id` claim, 404 site gone.
 *
 * `keepAwake` comes from `sites/{siteId}/settings/display`, the one read here
 * outside the site document. It is on by default: only an explicit `false`
 * turns it off, so a site that never touched the switch keeps its screens awake.
 *
 * `roostEnabled` is passed through verbatim, including null for unset, because
 * the agent's kill-switch helper fails OPEN on a missing field and must be able
 * to tell "absent" from "false". This field is here rather than read directly
 * because the agent's own read of `sites/{siteId}` 403s: the gate in
 * sync_commands called a `get_document` method that does not exist on
 * FirebaseClient, swallowed the AttributeError, and cached the resulting
 * fail-open for the full TTL — so the kill switch had never once been observed
 * by an agent, while the changelog said it was checked before every sync_pull.
 *
 * PROJECTION, not the raw documents: the four fields above are the whole contract.
 * `timezone` is gated on `schedulesFollowSiteTime === true` because a non-null
 * timezone flips schedule evaluation for every process on every machine at the
 * site from machine-local to site time. The field is three-state — absent means
 * the site was never asked, `false` means it declined — and only the explicit
 * `true` speaks here. Absent or false therefore reads exactly as it did before
 * site time existed: `timezone: null`, machine-local everywhere.
 *
 * The site comes from the token's own `site_id` claim (minted by
 * /api/agent/auth/device-code/poll), never from query or body, so a token can
 * only resolve its own site. `machine_id` is irrelevant — every field is
 * site-scoped. No cache headers; the agent refreshes on its own schedule.
 */
export const GET = withRateLimit(
  async (request: NextRequest) => {
    try {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

      if (!token) {
        return problemUnauthorized('missing Authorization header');
      }

      let decodedToken;
      try {
        const adminAuth = getAdminAuth();
        decodedToken = await adminAuth.verifyIdToken(token);
      } catch {
        return problemUnauthorized('invalid or expired token');
      }

      if (decodedToken.role !== 'agent') {
        return problemForbidden('agent token required');
      }

      const siteId = typeof decodedToken.site_id === 'string' ? decodedToken.site_id.trim() : '';
      if (!siteId) {
        return problemForbidden('agent token carries no site_id claim');
      }

      const siteRef = getAdminDb().collection('sites').doc(siteId);
      const [siteDoc, displayDoc] = await Promise.all([
        siteRef.get(),
        siteRef.collection('settings').doc('display').get(),
      ]);
      if (!siteDoc.exists) {
        return problemNotFound('site not found');
      }

      const siteData = siteDoc.data() ?? {};

      const rawName = siteData.name;
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;

      const rawTimezone = siteData.timezone;
      const timezone =
        siteData.schedulesFollowSiteTime === true &&
        typeof rawTimezone === 'string' &&
        rawTimezone.trim()
          ? rawTimezone.trim()
          : null;

      // Verbatim, null when unset — see the roostEnabled note in the header.
      const rawRoostEnabled = siteData[ROOST_ENABLED_FIELD];
      const roostEnabled =
        typeof rawRoostEnabled === 'boolean' ? rawRoostEnabled : null;

      // Default on — see the keepAwake note in the header.
      const keepAwake = displayDoc.data()?.keepAwake !== false;

      return NextResponse.json({ name, timezone, roostEnabled, keepAwake });
    } catch (error: unknown) {
      return apiError(error, 'agent/site');
    }
  },
  { strategy: 'api', identifier: 'ip' }
);
