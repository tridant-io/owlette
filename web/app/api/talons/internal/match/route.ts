/**
 * POST /api/talons/internal/match
 *
 * Internal ingress for fleet events that never reach a web route.
 * `process_restarted` and every `display_*` event go straight from the agent
 * into `sites/{siteId}/logs`, so the `onTalonLogEventCreated` trigger is their
 * only observer and forwards catalog matches here. The other three dispatchers
 * already hold a Firestore handle and tap the matcher in-process.
 *
 * Auth: `x-internal-secret` vs `CORTEX_INTERNAL_SECRET`, constant-time.
 *
 * Not public; registered in `INTERNAL_ROUTES` in scripts/validate-openapi.ts.
 *
 * Unlike the in-process taps this one AWAITS the matcher: the caller is a cloud
 * function with nothing else to do, and detaching would race a long run (a
 * visual check is a 45s capture plus a model call) against a sent response. The
 * caller's 10s timeout firing first is a non-event — the run continues here and
 * the function does not retry.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { problem, problemFromError, problemValidation, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { hootInternalSecret, hootInternalSecretMatches } from '@/lib/hootInternalSecret';
import { matchAndRunTalons } from '@/lib/talons/matcher.server';
import { TALON_EVENT_TYPES, type TalonEventType } from '@/lib/talons/types';

// the secret check and the run engine's webhook signing are both node:crypto.
export const runtime = 'nodejs';

function isCatalogEvent(value: unknown): value is TalonEventType {
  return (
    typeof value === 'string' &&
    TALON_EVENT_TYPES.some((eventType) => eventType === value)
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Inline rather than `_shared`'s `parseJsonBody`: that module drags the whole
 * api-key/scope/billing auth stack in, and this route authenticates on a
 * deployment secret alone.
 */
async function readBody(
  request: NextRequest,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse }> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: problemValidation('request body must be a json object') };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: problemValidation('request body is not valid json') };
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!hootInternalSecret()) {
      // 503, not 401: a missing server secret would send the caller hunting a
      // credential problem that doesn't exist.
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'not configured',
        status: 503,
        detail: 'the internal talon match endpoint is not configured.',
        instance: request.nextUrl.pathname,
        code: 'not_configured',
      });
    }

    if (!hootInternalSecretMatches(request.headers.get('x-internal-secret'))) {
      return problem({
        type: ProblemType.Unauthorized,
        title: 'unauthorized',
        status: 401,
        detail: 'a valid internal secret is required.',
        instance: request.nextUrl.pathname,
      });
    }

    const parsed = await readBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const siteId = readNonEmptyString(body.siteId);
    if (!siteId) {
      return problemValidation('`siteId` is required.', {
        'body.siteId': ['`siteId` must be a non-empty string.'],
      });
    }

    // Checked at the boundary, not in the matcher, so a caller typo doesn't
    // read back as "no talons matched".
    const eventType = body.eventType;
    if (!isCatalogEvent(eventType)) {
      return problemValidation('`eventType` is not a known talon event.', {
        'body.eventType': [`\`eventType\` must be one of: ${TALON_EVENT_TYPES.join(', ')}.`],
      });
    }

    const machineId = readNonEmptyString(body.machineId);

    const result = await matchAndRunTalons(getAdminDb(), siteId, {
      kind: 'event',
      eventType,
      ...(machineId ? { machineId } : {}),
    });

    return NextResponse.json({ ok: true, matched: result.matched });
  } catch (err) {
    return problemFromError(err, 'talons/internal/match:POST');
  }
}
