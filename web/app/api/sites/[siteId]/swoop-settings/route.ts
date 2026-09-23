/**
 * GET   /api/sites/{siteId}/swoop-settings — the site's swoop policy.
 * PATCH /api/sites/{siteId}/swoop-settings — change any subset of it.
 *
 * Body fields, all optional: `enabled`, `excludedMachineIds`,
 * `membersMayWatch`, `indicator`. Site-admin only, like the hoot-settings
 * precedent it copies — members read the document straight from Firestore
 * through `hooks/useSwoopSettings.ts`, which is what the existing
 * `settings/{settingId}` rule already allows.
 *
 * The write itself, and the `swoop_refresh` fan-out that makes a disable reach
 * a machine that is already connected, live in the action module.
 *
 * Api keys are refused on both verbs, like every other swoop route. This one is
 * the switch the rest stand behind — a key that can PATCH it can turn swoop on,
 * open it to members and set the on-screen indicator to none — and reading the
 * policy says whether a site can be watched and by whom.
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
import { loadSwoopSettings } from '@/lib/swoop/policy.server';
import {
  setSwoopSettings,
  type SetSwoopSettingsInput,
} from '@/lib/actions/setSwoopSettings.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

interface SwoopSettingsParams {
  [key: string]: string | undefined;
  siteId: string;
}

/**
 * Mirrors the machine swoop routes' `apiKeyRefusal`, which lives in their own
 * `_shared` and words itself for sessions. Not shared with it: nothing else
 * here needs it, and importing across that boundary for one 403 would be the
 * larger change.
 */
function refuseApiKey(ctx: SiteHandlerContext): NextResponse | null {
  if (ctx.auth.keyContext === null) return null;
  return problem({
    type: ProblemType.Forbidden,
    title: 'forbidden',
    status: 403,
    code: 'api_key_not_permitted',
    detail: 'swoop settings cannot be read or changed with an api key.',
  });
}

const readHandler: SiteRouteHandler<SwoopSettingsParams> = async (_request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const settings = await loadSwoopSettings(ctx.siteId);
    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: settings }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/swoop-settings:GET');
  }
};

const writeHandler: SiteRouteHandler<SwoopSettingsParams> = async (request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as SetSwoopSettingsInput;

    const result = await setSwoopSettings(
      { siteId: ctx.siteId, actor: ctx.actor, auditActor: auditActorOf(ctx) },
      {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.excludedMachineIds === undefined
          ? {}
          : { excludedMachineIds: body.excludedMachineIds }),
        ...(body.membersMayWatch === undefined ? {} : { membersMayWatch: body.membersMayWatch }),
        ...(body.indicator === undefined ? {} : { indicator: body.indicator }),
      },
      { correlationId: ctx.correlationId },
    );

    return applyAuthDeprecations(
      NextResponse.json({
        ok: true,
        data: { settings: result.settings, refreshed: result.refreshed.length },
      }),
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
    return problemFromError(err, 'sites/[siteId]/swoop-settings:PATCH');
  }
};

function auditActorOf(ctx: SiteHandlerContext): string {
  return ctx.auth.keyContext ? `apiKey:${ctx.auth.keyContext.keyId}` : `user:${ctx.actor.userId}`;
}

const sharedHandlerOptions = {
  // NOT MACHINE_CONFIG_WRITE. This route decides whether swoop runs on the site
  // at all, so it has to be at least as protected as the session routes it
  // stands in front of — which means exempt from the capability_enforcement
  // kill switch, and MACHINE_CONFIG_WRITE cannot be. Same grant (site
  // admin/owner), see lib/capabilities.ts.
  capability: Capability.SWOOP_SETTINGS_MANAGE,
  siteIdParam: 'path' as const,
};

export const GET = authorizedSiteHandler<SwoopSettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'read' as const },
})(readHandler);

export const PATCH = authorizedSiteHandler<SwoopSettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'write' as const },
})(writeHandler);
