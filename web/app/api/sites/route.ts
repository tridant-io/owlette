/**
 * GET  /api/sites
 * POST /api/sites
 *
 * List and create sites. Scoped API keys only see sites covered by explicit
 * `site` scopes; wildcard / legacy keys and session auth keep the underlying
 * user's account view.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  problemForbidden,
  problemNotFound,
  problemPlanRequired,
  problemScopeInsufficient,
  problemTokenExpired,
  problemValidation,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  applyAuthDeprecations,
  assertActiveUser,
  requireScope,
  resolveAuth,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { withIdempotency } from '@/lib/idempotency';
import { withRateLimit } from '@/lib/withRateLimit';
import { createSite } from '@/lib/actions/createSite.server';
import {
  applyAuthDeprecations as applyScopedAuthDeprecations,
  readAndParseJsonBody,
} from '../_shared';

interface CreateSiteBody {
  siteId?: unknown;
  name?: unknown;
  timezone?: unknown;
  schedulesFollowSiteTime?: unknown;
}

export async function GET(request: NextRequest) {
  try {
    let auth: ResolvedAuth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) {
        if (err.code === 'token_expired') {
          return problem({
            type: ProblemType.TokenExpired,
            title: 'token expired',
            status: 401,
            detail: err.message,
            code: 'token_expired',
            ...(err.details ?? {}),
          });
        }
        if (err.status === 403) return problemForbidden();
        if (err.status === 404) return problemNotFound();
        return problemUnauthorized();
      }
      throw err;
    }

    const db = getAdminDb();
    const userDoc = await db.collection('users').doc(auth.userId).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const isSuperadmin = userData?.role === 'superadmin';
    const assignedSites: string[] = Array.isArray(userData?.sites) ? userData!.sites : [];

    // Candidate site set for this user.
    let candidates: Set<string> | 'all';
    if (isSuperadmin) {
      candidates = 'all';
    } else {
      // plus sites owned directly
      const ownedSnap = await db.collection('sites').where('owner', '==', auth.userId).get();
      const ownedIds = ownedSnap.docs.map((d) => d.id);
      candidates = new Set([...assignedSites, ...ownedIds]);
    }

    // Intersect with the API-key scope when it names specific site ids.
    const scopeAllowed = scopeAllowedSites(auth.keyContext);

    let siteDocs: FirebaseFirestore.QueryDocumentSnapshot[];
    if (candidates === 'all') {
      const snap = await db.collection('sites').get();
      siteDocs = scopeAllowed
        ? snap.docs.filter((d) => scopeAllowed.has(d.id))
        : snap.docs;
    } else {
      const filtered = [...candidates].filter((id) =>
        scopeAllowed ? scopeAllowed.has(id) : true,
      );
      if (filtered.length === 0) {
        return applyAuthDeprecations(
          NextResponse.json({ sites: [] }),
          { isLegacy: auth.keyContext?.isLegacy === true },
        );
      }
      // Firestore 'in' queries cap at 30 — chunk.
      siteDocs = [];
      for (let i = 0; i < filtered.length; i += 30) {
        const chunk = filtered.slice(i, i + 30);
        const snap = await db.collection('sites').where('__name__', 'in', chunk).get();
        siteDocs.push(...snap.docs);
      }
    }

    const sites = siteDocs.map((d) => summariseSite(d));
    sites.sort((a, b) => a.name.localeCompare(b.name));

    return applyAuthDeprecations(
      NextResponse.json({ sites }),
      { isLegacy: auth.keyContext?.isLegacy === true },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites:GET');
  }
}

// Site creation is self-serve onboarding, NOT superadmin-only: any active
// authenticated caller (session, id-token, or `site:admin`-scoped key) may create
// one and becomes its owner. Do NOT route this through
// `authorizedPlatformHandler` — it hard-requires superadmin, which once locked
// new users out of their first site. Authorization is done inline here, keeping
// rate limiting, idempotency, audit, soft-delete rejection and scope checks.
export const POST = withRateLimit(async (request: NextRequest) => {
  try {
    let auth: ResolvedAuth;
    let scopeCheck: ScopeCheckResult;
    try {
      auth = await resolveAuth(request);
      // Soft-deleted / missing users, before any write.
      await assertActiveUser(auth.userId);
      // API keys need an explicit `site:admin`; sessions and id-tokens bypass
      // scope enforcement inside requireScope.
      scopeCheck = requireScope(auth, 'site', '*', 'admin');
    } catch (err) {
      // Mirrors authorizedHandler's authErrorToResponse so scope/token errors keep
      // their specific problem codes instead of collapsing to forbidden.
      if (err instanceof ApiAuthError) {
        if (err.code === 'token_expired') {
          const expiredAt = typeof err.details?.expiredAt === 'number' ? err.details.expiredAt : undefined;
          return problemTokenExpired(expiredAt);
        }
        if (err.code === 'scope_insufficient') {
          const d = err.details as { resource?: string; id?: string; permission?: string } | undefined;
          return problemScopeInsufficient(err.message, {
            resource: d?.resource ?? 'unknown',
            id: d?.id ?? 'unknown',
            permission: d?.permission ?? 'unknown',
          });
        }
        if (err.status === 401) return problemUnauthorized(err.message);
        if (err.status === 403) return problemForbidden(err.message);
        if (err.status === 404) return problemNotFound(err.message);
        return problem({
          type: ProblemType.Internal,
          title: 'authorization error',
          status: err.status,
          detail: err.message,
        });
      }
      throw err;
    }

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

    return await withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const body = parsed.body as CreateSiteBody;
        const result = await createSite(
          {
            auditActor: auth.keyContext
              ? `apiKey:${auth.keyContext.keyId}`
              : `user:${auth.userId}`,
            endpoint: '/api/sites',
            method: 'POST',
          },
          {
            siteId: typeof body.siteId === 'string' ? body.siteId : '',
            name: typeof body.name === 'string' ? body.name : '',
            ownerUid: auth.userId,
            timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
            // Anything but a real boolean is `undefined`, which leaves the field
            // off the document — the "never asked" state, not a decline.
            schedulesFollowSiteTime:
              typeof body.schedulesFollowSiteTime === 'boolean'
                ? body.schedulesFollowSiteTime
                : undefined,
          },
        );

        if (result.kind === 'invalid_site_id') {
          return problemValidation(result.reason, {
            'body.siteId': [result.reason],
          });
        }
        if (result.kind === 'invalid_name') {
          return problemValidation(result.reason, {
            'body.name': [result.reason],
          });
        }
        if (result.kind === 'id_retired') {
          return problem({
            type: ProblemType.Conflict,
            title: 'site id retired',
            status: 409,
            detail:
              `site id ${String(body.siteId)} belonged to a deleted site and cannot be reused; choose another`,
            instance: '/api/sites',
            code: 'site_id_retired',
          });
        }
        if (result.kind === 'already_exists') {
          return problem({
            type: ProblemType.Conflict,
            title: 'site already exists',
            status: 409,
            detail: `site ${String(body.siteId)} already exists`,
            instance: '/api/sites',
            code: 'site_already_exists',
          });
        }
        if (result.kind === 'plan_limit') {
          return problemPlanRequired(
            "your plan doesn't cover another site. upgrade for more sites.",
            'owlette.sites',
          );
        }
        return applyScopedAuthDeprecations(
          NextResponse.json(
            {
              siteId: result.siteId,
              name: result.name,
              timezone: result.timezone,
              owner: result.owner,
              createdAt: result.createdAt,
              schedulesFollowSiteTime: result.schedulesFollowSiteTime,
            },
            { status: 201 },
          ),
          scopeCheck,
        );
      },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites:POST');
  }
}, { strategy: 'api', identifier: 'ip' });

/**
 * Null = unrestricted (session, legacy key, or site wildcard); Set = restricted
 * to explicit site ids. Scoped API keys with no site scopes get an empty set.
 */
function scopeAllowedSites(keyContext: ResolvedAuth['keyContext']): Set<string> | null {
  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) return null;
  const ids = new Set<string>();
  for (const s of keyContext.scopes) {
    if (s.resource !== 'site') continue;
    if (s.id === '*') return null; // wildcard beats any restriction
    ids.add(s.id);
  }
  return ids;
}

function summariseSite(d: FirebaseFirestore.QueryDocumentSnapshot): {
  id: string;
  name: string;
  plan: string | null;
  timezone: string | null;
  owner: string | null;
  createdAt: string | null;
  schedulesFollowSiteTime: boolean;
} {
  const data = d.data();
  return {
    id: d.id,
    name: typeof data.name === 'string' ? data.name : d.id,
    plan: typeof data.plan === 'string' ? data.plan : null,
    timezone: typeof data.timezone === 'string' ? data.timezone : null,
    owner: typeof data.owner === 'string' ? data.owner : null,
    createdAt: timestampToIso(data.createdAt),
    // Effective value: the document's third state ("never asked", i.e. the field
    // is absent) reads as `false` here, because the API answers "is site time
    // on" and an unanswered site runs on machine clocks.
    schedulesFollowSiteTime: data.schedulesFollowSiteTime === true,
  };
}

