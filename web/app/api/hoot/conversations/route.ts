/**
 * Canonical Hoot conversation collection: GET lists, POST creates.
 *
 * GET filters to the caller's effective site access set; for api-key callers
 * that set is intersected with the key's `chat=<siteId>:read` scopes, so a
 * single-site key can't list other sites even when its user has access.
 *
 * POST requires `chat=<siteId>:write`, idempotent via `Idempotency-Key`.
 * Body: { siteId, machineId?, title?, initial_message?: { role, content } }.
 * Omitting machineId makes the conversation site-wide (tools fan out across
 * every online machine); supplying it pins every turn to that machine. A
 * machineId outside the caller's machine scope answers 404 'machine not found
 * or no access'.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemNotFound,
  problemUnauthorized,
  mfaChallengeProblem,
  problemValidation,
} from '@/lib/apiErrors';
import { ApiAuthError, resolveAuth } from '@/lib/apiAuth.server';
import { listUserSiteIds } from '@/lib/membership.server';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import {
  applyAuthDeprecations,
  requireChatAuthAndScope,
  readAndParseJsonBody,
} from '@/app/api/_shared';
import {
  listConversations,
  createConversation,
  serializeConversationSummary,
  serializeConversation,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ChatRole,
} from '@/lib/chatStorage.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { SITE_ID_RE } from '@/lib/sitePolicy.server';
import { scopeCovers } from '@/lib/machineAccess';

const VALID_ROLES: ChatRole[] = ['user'];

export async function GET(request: NextRequest) {
  try {
    let auth;
    try {
      auth = await resolveAuth(request);
    } catch (err) {
      if (err instanceof ApiAuthError) return mfaChallengeProblem(err) ?? problemUnauthorized();
      throw err;
    }

    const pageSizeRaw = Number(
      request.nextUrl.searchParams.get('page_size') ??
        request.nextUrl.searchParams.get('limit') ??
        DEFAULT_PAGE_SIZE,
    );
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(
        1,
        Number.isFinite(pageSizeRaw) ? Math.floor(pageSizeRaw) : DEFAULT_PAGE_SIZE,
      ),
    );
    const pageToken =
      request.nextUrl.searchParams.get('page_token') ??
      request.nextUrl.searchParams.get('cursor') ??
      '';
    const includeDeleted = request.nextUrl.searchParams.get('includeDeleted') === 'true';
    // Conversations are user-private: default to "owner is me" or any site member
    // could enumerate others' chats. `?owner=all` is superadmin-only.
    const ownerParam = request.nextUrl.searchParams.get('owner');
    let ownerFilter: string | undefined = auth.userId;
    if (ownerParam === 'all') {
      const userDoc = await getAdminDb().collection('users').doc(auth.userId).get();
      const isSuperadmin = userDoc.exists && userDoc.data()?.role === 'superadmin';
      if (isSuperadmin) ownerFilter = undefined;
    }
    const siteIdRaw = request.nextUrl.searchParams.get('siteId');

    let requestedSiteId: string | undefined;
    if (siteIdRaw !== null) {
      requestedSiteId = siteIdRaw.trim();
      if (!SITE_ID_RE.test(requestedSiteId)) {
        return problemValidation('invalid siteId format', {
          'query.siteId': ['must be 1-128 chars: letters, digits, underscore, hyphen'],
        });
      }
    }

    const accessibleSiteIds = await resolveReadableSiteIds(auth.userId, auth.keyContext);
    const effectiveSiteIds = requestedSiteId
      ? accessibleSiteIds.filter((siteId) => siteId === requestedSiteId)
      : accessibleSiteIds;

    if (effectiveSiteIds.length === 0) {
      return NextResponse.json({
        ok: true,
        data: { conversations: [], next_page_token: '', nextPageToken: '' },
      });
    }

    const result = await listConversations({
      siteIds: effectiveSiteIds,
      ownerUid: ownerFilter,
      pageSize,
      pageToken,
      includeDeleted,
    });

    return NextResponse.json({
      ok: true,
      data: {
        conversations: result.conversations.map(serializeConversationSummary),
        next_page_token: result.nextPageToken,
        nextPageToken: result.nextPageToken,
      },
    });
  } catch (err) {
    return problemFromError(err, 'hoot/conversations:GET');
  }
}

/**
 * Site ids whose conversations the caller may read.
 * - Session/id-token: membership list plus owned sites. No wildcard even for
 *   superadmins — the list helper requires a site-id filter for query plans.
 * - Scoped api keys: membership ∩ the key's `chat` scopes (`chat=*` widens
 *   back to the full membership list).
 * - Legacy keys (no `scopes`): treated like session callers.
 */
async function resolveReadableSiteIds(
  userId: string,
  keyContext: Awaited<ReturnType<typeof resolveAuth>>['keyContext'],
): Promise<string[]> {
  // Member ROWS, not `users/{uid}.sites[]`. That array is legacy and wave 6.1
  // strips it; reading it here would have made this route return an empty 200
  // — no error, no log — for every caller the moment the migration ran.
  //
  // The owned-sites read stays as a transitional union: on an environment where
  // the membership backfill has not run yet, a site owner has no member row, and
  // dropping it would lock them out of their own conversations. It is redundant
  // once backfilled (owners get a row with role 'owner') and is safe to remove
  // after prod is migrated.
  const membership = await listUserSiteIds(userId);
  const ownedSites = await readOwnedSiteIds(userId);
  const membershipSet = new Set<string>([...membership, ...ownedSites]);

  if (!keyContext || keyContext.isLegacy || !keyContext.scopes) {
    return [...membershipSet];
  }

  const chatScopes = keyContext.scopes.filter(
    (s) => s.resource === 'chat' && s.permissions.includes('read'),
  );
  if (chatScopes.length === 0) return [];
  if (chatScopes.some((s) => s.id === '*')) return [...membershipSet];

  const allowed = new Set(chatScopes.map((s) => s.id));
  return [...membershipSet].filter((siteId) => allowed.has(siteId));
}

async function readOwnedSiteIds(userId: string): Promise<string[]> {
  try {
    const db = getAdminDb();
    const snap = await db.collection('sites').where('owner', '==', userId).get();
    return snap.docs.map((d) => d.id);
  } catch {
    // Degrade to the membership list: this filter only narrows, it never grants
    // access beyond the scope/membership check.
    return [];
  }
}

interface CreateBody {
  siteId?: unknown;
  machineId?: unknown;
  title?: unknown;
  initial_message?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateBody;

    if (typeof body.siteId !== 'string' || body.siteId.trim().length === 0) {
      return problemValidation('field `siteId` is required and must be a non-empty string', {
        'body.siteId': ['required non-empty string'],
      });
    }
    const siteId = body.siteId.trim();

    let machineId: string | undefined;
    if (body.machineId !== undefined && body.machineId !== null) {
      if (typeof body.machineId !== 'string' || body.machineId.length === 0) {
        return problemValidation('machineId must be a non-empty string when provided', {
          'body.machineId': ['must be non-empty string'],
        });
      }
      machineId = body.machineId;
    }

    let initialMessage: { role: ChatRole; content: string } | undefined;
    if (body.initial_message !== undefined && body.initial_message !== null) {
      if (typeof body.initial_message !== 'object') {
        return problemValidation('initial_message must be an object when provided', {
          'body.initial_message': ['must be object'],
        });
      }
      const im = body.initial_message as Record<string, unknown>;
      const role = im.role;
      const content = im.content;
      if (typeof role !== 'string' || !VALID_ROLES.includes(role as ChatRole)) {
        return problemValidation(
          'initial_message.role must be `user` for public Hoot conversations',
          { 'body.initial_message.role': ['invalid role'] },
        );
      }
      if (typeof content !== 'string' || content.length === 0) {
        return problemValidation('initial_message.content must be a non-empty string', {
          'body.initial_message.content': ['required non-empty string'],
        });
      }
      initialMessage = { role: role as ChatRole, content };
    }

    const auth = await requireChatAuthAndScope(request, siteId, 'write');
    if (!auth.ok) return auth.response;
    // a site-wide conversation stays open to a scoped member: runHootStream narrows it
    // to their machines
    if (machineId && !scopeCovers(auth.machineIds, machineId)) {
      return problemNotFound('machine not found or no access');
    }

    return withIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const conversation = await createConversation({
          siteId,
          ownerUid: auth.userId,
          machineId,
          title: typeof body.title === 'string' ? body.title : undefined,
          initialMessages: initialMessage ? [initialMessage] : undefined,
        });

        emitMutation({
          kind: 'chat_mutated',
          siteId,
          actor: auth.auth.keyContext
            ? `apiKey:${auth.auth.keyContext.keyId}`
            : `user:${auth.userId}`,
          targetId: conversation.conversationId,
          attributes: {
            verb: 'create',
            endpoint: request.nextUrl.pathname,
            method: 'POST',
            siteId,
            ...(machineId ? { machineId } : {}),
          },
        });

        return applyAuthDeprecations(
          NextResponse.json(
            { ok: true, data: serializeConversation(conversation) },
            { status: 201 },
          ),
          auth.scopeCheck,
        );
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'hoot/conversations:POST');
  }
}
