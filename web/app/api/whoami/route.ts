/**
 * GET /api/whoami — caller identity: userId, API-key context, scopes,
 * environment, and a best-effort rateLimit + quota summary. Accepts any auth
 * path resolveAuth() supports. roost public api wave 3.9.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timestampToMs } from '@/lib/firestoreTime.server';
import {
  problem,
  problemFromError,
  mfaChallengeProblem,
  problemForbidden,
  problemNotFound,
  problemUnauthorized,
  ProblemType,
} from '@/lib/apiErrors';
import {
  ApiAuthError,
  applyAuthDeprecations,
  resolveAuth,
  type ResolvedAuth,
} from '@/lib/apiAuth.server';
import { normalizeMaxToolTier } from '@/lib/apiKeyTypes';
import { getAdminDb } from '@/lib/firebase-admin';
import type { ToolTier } from '@/lib/mcp-tools';
import { SITE_STORAGE_BYTES } from '@/lib/roostStorage';

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

    const db = getAdminDb();
    const userSnap = await db.collection('users').doc(auth.userId).get();
    const userData = userSnap.exists ? userSnap.data() ?? null : null;
    const role = typeof userData?.role === 'string' ? userData.role : null;

    // only populated when an API key authed the request
    let keyInfo: {
      keyId: string | null;
      name: string | null;
      keyPrefix: string | null;
      scopes: unknown;
      maxToolTier: ToolTier;
      environment: string | null;
      expiresAt: number | null;
      lastUsedAt: number | null;
      isLegacy: boolean;
    } | null = null;

    if (auth.keyContext) {
      const kc = auth.keyContext;
      let name: string | null = null;
      let keyPrefix: string | null = null;
      let lastUsedAt: number | null = null;
      try {
        const keyDocSnap = await db
          .collection('users')
          .doc(auth.userId)
          .collection('api_keys')
          .doc(kc.keyId)
          .get();
        if (keyDocSnap.exists) {
          const d = keyDocSnap.data() ?? {};
          name = typeof d.name === 'string' ? d.name : null;
          keyPrefix = typeof d.keyPrefix === 'string' ? d.keyPrefix : null;
          lastUsedAt = timestampToMs(d.lastUsedAt);
        }
      } catch {
        /* whoami must not fail over metadata enrichment */
      }

      keyInfo = {
        keyId: kc.keyId,
        name,
        keyPrefix,
        scopes: kc.isLegacy ? null : kc.scopes,
        maxToolTier: normalizeMaxToolTier(kc.maxToolTier),
        environment: kc.environment,
        expiresAt: kc.expiresAt,
        lastUsedAt,
        isLegacy: kc.isLegacy,
      };
    }

    // Plan ceiling only: the upstash sliding window is write-only from here, so
    // there is no readable per-key remaining count. Live counters: RateLimit-* headers.
    const rateLimit = {
      tier: 'api',
      limitPerMinute: 600,
      note: 'use RateLimit-* response headers on actual API calls for live counters',
    };

    // primary site: first API-key site scope, else the user's first assigned site
    const primarySiteId = pickPrimarySiteId(auth, userData);
    let quota: Record<string, unknown> | null = null;
    if (primarySiteId) {
      quota = await loadQuotaSummary(primarySiteId);
    }

    return applyAuthDeprecations(
      NextResponse.json({
        userId: auth.userId,
        email: typeof userData?.email === 'string' ? userData.email : null,
        role,
        key: keyInfo,
        rateLimit,
        quota,
        primarySiteId,
      }),
      { isLegacy: auth.keyContext?.isLegacy === true },
    );
  } catch (err) {
    return problemFromError(err, 'v2/whoami:GET');
  }
}

function pickPrimarySiteId(
  auth: ResolvedAuth,
  userData: FirebaseFirestore.DocumentData | null,
): string | null {
  const scopes = auth.keyContext?.scopes;
  if (Array.isArray(scopes)) {
    for (const s of scopes) {
      if (s.resource === 'site' && s.id !== '*') return s.id;
    }
  }
  const sites = Array.isArray(userData?.sites) ? userData.sites : [];
  if (sites.length > 0 && typeof sites[0] === 'string') return sites[0];
  return null;
}

async function loadQuotaSummary(siteId: string): Promise<Record<string, unknown> | null> {
  try {
    const db = getAdminDb();
    const quotaRef = db.collection('sites').doc(siteId).collection('roost').doc('quota');
    const [quotaSnap, pendingSnap] = await Promise.all([
      quotaRef.get(),
      quotaRef.collection('pending').get(),
    ]);
    const data = quotaSnap.exists ? quotaSnap.data() ?? {} : {};
    const usedBytes = typeof data.usedBytes === 'number' ? data.usedBytes : 0;
    const pendingBytes = pendingSnap.docs.reduce(
      (n, d) => n + ((d.data() as { bytes?: number }).bytes ?? 0),
      0,
    );
    // same resolution as GET /api/sites/{siteId}/quota so the two can't disagree
    const limitBytes = typeof data.planLimitBytes === 'number'
      ? data.planLimitBytes
      : SITE_STORAGE_BYTES;
    return {
      siteId,
      usedBytes,
      pendingBytes,
      limitBytes,
    };
  } catch {
    return null;
  }
}
