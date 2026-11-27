/**
 * GET  /api/sites
 * POST /api/sites
 *
 * List and create sites. Scoped API keys only see sites covered by explicit
 * `site` scopes; wildcard / legacy keys and session auth keep the underlying
 * user's account view.
 *
 * `GET ?include=machines` (sessions only) adds each site's machines, read as
 * `GET /api/sites/{siteId}/machines` reads them, in one request for the admin
 * panel's site list. the listing is a candidate set, so each site's machines
 * come from the decision core: a site the caller cannot reach gets `null`.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToIso } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  mfaChallengeProblem,
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
  assertUserHasSiteAccess,
  requireScope,
  resolveAuth,
  type ResolvedAuth,
  type ScopeCheckResult,
} from '@/lib/apiAuth.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { MAX_MACHINE_SCOPE, scopeCovers } from '@/lib/machineAccess';
import { MACHINE_STATUS_FIELDS, machineStatus, type MachineStatus } from '@/lib/machineStatus.server';
import { withIdempotency } from '@/lib/idempotency';
import { withRateLimit } from '@/lib/withRateLimit';
import { createSite } from '@/lib/actions/createSite.server';
import { notBilledDetail } from '@/lib/planResponse';
import { siteSettingsPath } from '@/lib/siteSettingsPath';
import {
  applyAuthDeprecations as applyScopedAuthDeprecations,
  readAndParseJsonBody,
} from '../_shared';

interface CreateSiteBody {
  siteId?: unknown;
  name?: unknown;
  timezone?: unknown;
  schedulesFollowSiteTime?: unknown;
  onPlan?: unknown;
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
        if (err.status === 403) return mfaChallengeProblem(err) ?? problemForbidden();
        if (err.status === 404) return problemNotFound();
        return problemUnauthorized();
      }
      throw err;
    }

    const include = new URL(request.url).searchParams.get('include');
    if (include !== null && include !== 'machines') {
      return problemValidation('include takes one value, machines', {
        'query.include': ['must be "machines"'],
      });
    }
    const withMachines = include === 'machines';
    // a key's machine reads go through the per-site route, which holds its
    // `site=<id>:read` scope, the `owlette.api_keys` plan gate and the key-use audit
    if (withMachines && auth.keyContext) {
      return problem({
        type: ProblemType.Forbidden,
        title: 'forbidden',
        status: 403,
        code: 'api_key_not_permitted',
        detail:
          'include=machines is not available to an api key; list a site\'s machines with GET /api/sites/{siteId}/machines.',
      });
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

    if (withMachines) {
      const siteIds = sites.map((s) => s.id);
      // the decision core refuses an inactive user before it honours superadmin
      const machines = !isSuperadmin
        ? await reachableMachines(db, auth.userId, siteIds)
        : typeof userData?.deletedAt === 'number'
          ? new Map<string, MachineStatus[]>()
          : await everySitesMachines(db, siteIds);
      return NextResponse.json({
        sites: sites.map((s) => ({ ...s, machines: machines.get(s.id) ?? null })),
      });
    }

    return applyAuthDeprecations(
      NextResponse.json({ sites }),
      { isLegacy: auth.keyContext?.isLegacy === true },
    );
  } catch (err) {
    return problemFromError(err, 'v2/sites:GET');
  }
}

function byName(a: MachineStatus, b: MachineStatus): number {
  return a.name.localeCompare(b.name);
}

/**
 * a superadmin's machines on the listed sites, from one collection-group read
 * (their machine scope is always the whole site). the group also holds
 * `config/{siteId}/machines`, so only `sites/{id}/machines` counts.
 */
async function everySitesMachines(
  db: FirebaseFirestore.Firestore,
  siteIds: string[],
): Promise<Map<string, MachineStatus[]>> {
  const snap = await db.collectionGroup('machines').select(...MACHINE_STATUS_FIELDS).get();
  const nowSec = Math.floor(Date.now() / 1000);
  const bySite = new Map<string, MachineStatus[]>(siteIds.map((id) => [id, []]));
  for (const doc of snap.docs) {
    const site = doc.ref.parent.parent;
    if (!site || site.parent.path !== 'sites') continue;
    bySite.get(site.id)?.push(machineStatus(doc.id, doc.data(), nowSec));
  }
  for (const list of bySite.values()) list.sort(byName);
  return bySite;
}

/**
 * each listed site's machines as the caller's member row reaches them; a site
 * the decision core refuses has no entry. the scope stops at MAX_MACHINE_SCOPE,
 * as the dashboard and the site switcher's count do.
 */
async function reachableMachines(
  db: FirebaseFirestore.Firestore,
  userId: string,
  siteIds: string[],
): Promise<Map<string, MachineStatus[]>> {
  const nowSec = Math.floor(Date.now() / 1000);
  const entries = await Promise.all(
    siteIds.map(async (siteId): Promise<[string, MachineStatus[]] | null> => {
      let scope: readonly string[] | null;
      try {
        scope = (await assertUserHasSiteAccess(userId, siteId)).machineIds;
      } catch (err) {
        if (err instanceof ApiAuthError) return null;
        throw err;
      }
      const reached = scope === null ? null : scope.slice(0, MAX_MACHINE_SCOPE);
      const snap = await db
        .collection('sites')
        .doc(siteId)
        .collection('machines')
        .select(...MACHINE_STATUS_FIELDS)
        .get();
      const machines = snap.docs
        .filter((d) => scopeCovers(reached, d.id))
        .map((d) => machineStatus(d.id, d.data(), nowSec))
        .sort(byName);
      return [siteId, machines];
    }),
  );
  return new Map(entries.filter((e): e is [string, MachineStatus[]] => e !== null));
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
        if (err.status === 403) return mfaChallengeProblem(err) ?? problemForbidden(err.message);
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
            // a site created on its way to a plan is upgraded next, and the billing route refuses
            // every api key: a key's site would be left unpaid, and block every create after it.
            onPlan: body.onPlan === true && !auth.keyContext,
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
          const { siteCreation } = result;
          const { unpaidSite } = siteCreation;
          return siteCreation.state === 'blocked'
            ? problemPlanRequired(
                notBilledDetail(unpaidSite.name),
                'owlette.sites',
                { siteCreation, upgradeUrl: siteSettingsPath(unpaidSite.siteId, 'billing') },
              )
            : problemPlanRequired(
                `owlette free covers one site, and ${unpaidSite.name} is on it. add this site on core or pro.`,
                'owlette.sites',
                { siteCreation },
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

