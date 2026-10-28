/**
 * GET   /api/sites/{siteId}/display-settings — the site's display policy.
 * PATCH /api/sites/{siteId}/display-settings — body `{ keepAwake: boolean }`.
 *
 * site-admin only, like the hoot-settings precedent: members read the
 * document straight from firestore through `hooks/useDisplaySettings.ts`. the
 * write, and the `site_settings_refresh` fan-out that makes a change reach
 * machines that are already connected, live in the action module.
 *
 * api keys are refused on both verbs, as on swoop-settings: the switch is a
 * dashboard control, and a key with site write would otherwise be able to let
 * every screen on a site go to sleep.
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
import { loadDisplaySettings } from '@/lib/display/settings.server';
import {
  setDisplaySettings,
  type SetDisplaySettingsInput,
} from '@/lib/actions/setDisplaySettings.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';

interface DisplaySettingsParams {
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
    detail: 'display settings cannot be read or changed with an api key.',
  });
}

const readHandler: SiteRouteHandler<DisplaySettingsParams> = async (_request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const settings = await loadDisplaySettings(ctx.siteId);
    return applyAuthDeprecations(
      NextResponse.json({ ok: true, data: settings }),
      ctx.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/display-settings:GET');
  }
};

const writeHandler: SiteRouteHandler<DisplaySettingsParams> = async (request, ctx) => {
  try {
    const keyRefusal = refuseApiKey(ctx);
    if (keyRefusal) return keyRefusal;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as SetDisplaySettingsInput;

    // keys were refused above, so the actor is always a signed-in user.
    const result = await setDisplaySettings(
      { siteId: ctx.siteId, actor: ctx.actor, auditActor: `user:${ctx.actor.userId}` },
      { keepAwake: body.keepAwake },
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
    return problemFromError(err, 'sites/[siteId]/display-settings:PATCH');
  }
};

const sharedHandlerOptions = {
  capability: Capability.MACHINE_CONFIG_WRITE,
  siteIdParam: 'path' as const,
};

export const GET = authorizedSiteHandler<DisplaySettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'read' as const },
})(readHandler);

export const PATCH = authorizedSiteHandler<DisplaySettingsParams>({
  ...sharedHandlerOptions,
  apiKeyScope: { resource: 'site' as const, idParam: 'siteId', permission: 'write' as const },
})(writeHandler);
