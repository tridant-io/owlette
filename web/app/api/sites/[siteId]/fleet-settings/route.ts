/**
 * GET   /api/sites/{siteId}/fleet-settings — which machines of the site may act
 *       on its machines, at what tier and on which machines (ADR 0017).
 * PATCH /api/sites/{siteId}/fleet-settings — body `{ enabled?, senders? }`;
 *       `senders`, when given, is the whole new map.
 *
 * site owner and site admin only. members read the document straight from
 * firestore through `hooks/useFleetSettings.ts`, which the `settings/{settingId}`
 * rule already allows. the write, the sessions it deletes and the refresh it
 * sends a newly granted machine live in the action module.
 *
 * api keys are refused on both verbs, as on swoop-settings and
 * display-settings: granting a machine is a person's decision, made with a
 * session. raising a sender's tier, a new sender's above 1 included, needs a
 * session that passed a second factor, as raising a key's tool tier does.
 */

import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '@/app/api/_shared';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
  type SiteRouteHandler,
} from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import { loadFleetSettings } from '@/lib/fleet/policy.server';
import {
  raisesFleetTier,
  setFleetSettings,
  storedFleetSettings,
  type SetFleetSettingsInput,
} from '@/lib/actions/setFleetSettings.server';
import { requireVerifiedSessionForToolTier } from '@/app/api/keys/_shared';
import { ActionInputError } from '@/lib/actions/createProcess.server';

interface FleetSettingsParams {
  [key: string]: string | undefined;
  siteId: string;
}

function refuseApiKey(ctx: SiteHandlerContext): NextResponse | null {
  if (ctx.auth.keyContext === null) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    code: 'api_key_not_permitted',
    detail: 'these settings cannot be read or changed with an api key.',
  });
}

const readHandler: SiteRouteHandler<FleetSettingsParams> = async (_request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const settings = await loadFleetSettings(ctx.siteId);
    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: storedFleetSettings(settings) }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/fleet-settings:GET');
  }
};

const writeHandler: SiteRouteHandler<FleetSettingsParams> = async (request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const input = (parsed.body ?? {}) as SetFleetSettingsInput;

    // keys were refused above, so the actor is always a signed-in user. raising
    // a sender's tier asks what raising an api key's tool tier asks.
    if (raisesFleetTier(await loadFleetSettings(ctx.siteId), input)) {
      const unverified = await requireVerifiedSessionForToolTier(request, ctx.actor.userId);
      if (unverified) return unverified;
    }

    const result = await setFleetSettings(
      { siteId: ctx.siteId, actor: ctx.actor, auditActor: `user:${ctx.actor.userId}` },
      input,
      { correlationId: ctx.correlationId },
    );

    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: { settings: storedFleetSettings(result.settings) } }),
      ctx.scopeCheck,
    );
  } catch (err) {
    if (err instanceof ActionInputError) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'validation failed',
        status: err.status,
        detail: err.message,
        code: err.code,
      });
    }
    return problemFromError(err, 'sites/[siteId]/fleet-settings:PATCH');
  }
};

const sharedHandlerOptions = {
  // its own capability, exempt from the capability_enforcement kill switch: a
  // grant written while enforcement is off would outlive that window.
  capability: Capability.FLEET_SETTINGS_MANAGE,
  siteIdParam: 'path' as const,
};

export const GET = authorizedSiteHandler<FleetSettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'read' as const },
})(readHandler);

export const PATCH = authorizedSiteHandler<FleetSettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'write' as const },
})(writeHandler);
