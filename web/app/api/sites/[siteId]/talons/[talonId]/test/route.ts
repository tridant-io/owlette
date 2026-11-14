/**
 * POST /api/sites/{siteId}/talons/{talonId}/test — run a talon on demand
 * (the re-run button on `/talons`). Thin shim over `runTalonManual`, which owns
 * what makes a manual fire different: cooldown bypassed, and every run recorded
 * with `manual: true` so the run list distinguishes operator from trigger fires.
 *
 * Deliberately NOT idempotent — pressing twice means run twice. It cannot
 * overlap though: the engine's in-flight guard records a `skipped` run, returned
 * like any other.
 *
 * plan-gated on `owlette.talons` by the wrapper's plan lockout, as authoring is.
 *
 * Capability: TALON_MANAGE with the write-class api-key default. talons wave 4.2.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problemFromError, problemValidation } from '@/lib/apiErrors';
import {
  authorizedSiteHandler,
  type SiteHandlerContext,
} from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { runTalonManual } from '@/lib/talons/engine.server';
import { TalonStoreError } from '@/lib/talons/store.server';

import { talonStoreProblem } from '../../route';

// The engine reaches storage, the vision model, and the webhook signer.
export const runtime = 'nodejs';

/** Matches the sibling routes' bound — its job is rejecting path-escaping ids. */
const TALON_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type RouteParams = { siteId: string; talonId: string };
type RouteContext = { params: Promise<RouteParams> };

export const POST = authorizedSiteHandler<RouteParams>({
  capability: 'TALON_MANAGE',
  siteIdParam: 'path',
  targetKind: 'talon',
  targetIdParam: 'talonId',
})(async (request: NextRequest, ctx: SiteHandlerContext, routeContext: RouteContext) => {
  try {
    const { talonId } = await routeContext.params;
    if (!TALON_ID_RE.test(talonId)) {
      return problemValidation('invalid talon id', {
        'path.talonId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
      });
    }

    // One summary per machine the talon's scope resolved to, in the order the
    // runs were recorded. An unknown talon raises TalonStoreError(404).
    const runs = await runTalonManual(getAdminDb(), ctx.siteId, talonId, ctx.actor);

    return NextResponse.json({ runs });
  } catch (err) {
    if (err instanceof TalonStoreError) {
      return talonStoreProblem(err, request.nextUrl.pathname);
    }
    return problemFromError(err, 'sites/[siteId]/talons/[talonId]/test:POST');
  }
});
