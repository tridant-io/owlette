/**
 * POST /api/agent/swoop/doorbell-token — mint the short-lived `role=doorbell`
 * token an idle machine parks its signaling socket on.
 *
 * The body is empty on purpose: site and machine come from the agent token's
 * claims, and the `machine` claim is what the Worker derives its Durable Object
 * name from. The response therefore also carries `signalUrl`, because the agent
 * has no signaling origin of its own, and `expiresIn`, so the refresh deadline
 * is the API's arithmetic rather than a JWT parsed against the kiosk clock.
 *
 * A machine whose site has swoop off is refused with 403 and holds no socket —
 * the agent's slow-retry path is written against that. Nothing here is logged.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { loadSwoopSettings } from '@/lib/swoop/policy.server';
import { mintDoorbellToken, swoopJwtPublicKeys } from '@/lib/swoop/tokens.server';
import { withRateLimit } from '@/lib/withRateLimit';
import { NO_STORE, requireSwoopAgent, swoopRoomUrl } from '../_shared';

export const POST = withRateLimit(
  async (request: NextRequest): Promise<NextResponse> => {
    try {
      const auth = await requireSwoopAgent(request, 'read');
      if (!auth.ok) return auth.response;
      const { siteId, machineId } = auth.agent;

      const settings = await loadSwoopSettings(siteId);
      if (!settings.enabled) {
        return NextResponse.json(
          { error: 'swoop is not enabled for this site.', code: 'swoop_disabled' },
          { status: 403, headers: NO_STORE },
        );
      }
      if (settings.excludedMachineIds.includes(machineId)) {
        return NextResponse.json(
          { error: 'swoop is excluded on this machine.', code: 'machine_excluded' },
          { status: 403, headers: NO_STORE },
        );
      }

      const signalUrl = swoopRoomUrl(siteId, machineId);
      if (!signalUrl) {
        // 503, not 4xx: the agent treats a 4xx as "disabled here, slow retry",
        // and a missing origin is our misconfiguration, not the site's policy.
        return NextResponse.json(
          { error: 'signaling is not configured.', code: 'signal_not_configured' },
          { status: 503, headers: NO_STORE },
        );
      }

      const minted = mintDoorbellToken({ site: siteId, machine: machineId });

      return NextResponse.json(
        {
          token: minted.token,
          kid: swoopJwtPublicKeys()[0].kid,
          expiresIn: minted.expiresAt - minted.issuedAt,
          signalUrl,
        },
        { headers: NO_STORE },
      );
    } catch (error: unknown) {
      return apiError(error, 'agent/swoop/doorbell-token');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
