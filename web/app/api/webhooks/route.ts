/**
 * POST /api/webhooks?siteId=... — create a subscription at
 * `sites/{siteId}/webhooks/{webhookId}`. Validates the url (https, no
 * private/loopback/link-local, dns-resolved addresses re-checked) and events[]
 * against `ROOST_WEBHOOK_EVENTS`.
 *
 * The `whsec_*` signing secret is returned ONCE here and then stored plaintext
 * (needed for server-side hmac at dispatch; relies on Firestore encryption at
 * rest) — no other endpoint ever returns it.
 *
 * GET /api/webhooks?siteId=...&limit=&cursor= — cursor-paginated list,
 * soft-deleted filtered out, never includes signingSecret.
 *
 * Scope: site:<id>:write for POST, site:<id>:read for GET.
 */

import { randomBytes } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { timestampToIso } from '@/lib/firestoreTime.server';

import { emitMutation } from '@/lib/auditLogClient';
import {
  problemFromError,
  problemValidation,
  problem,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { writeWebhookSecret } from '@/lib/webhookSecrets.server';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import {
  collectFilteredPage,
  parsePagination,
  withPaginationFields,
} from '@/lib/pagination';
import { validateEvents } from '@/lib/webhookEvents';
import { validateWebhookUrl } from '@/lib/webhookUrl';

import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../_shared';

export const runtime = 'nodejs';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

const MAX_DESCRIPTION_LENGTH = 500;
const WEBHOOK_ID_BYTES = 9;
const SIGNING_SECRET_BYTES = 32;

interface CreateWebhookBody {
  url?: unknown;
  events?: unknown;
  description?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    // Membership + scope are not enough: creating a subscription is a site-admin
    // action (WEBHOOK_MANAGE), so a plain member on the site is refused here.
    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId, {
      create: true,
    });
    if (capabilityError) return capabilityError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CreateWebhookBody;

    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    // Scheme, port, literal ips, dns-resolved ips.
    const urlValidation = await validateWebhookUrl(body.url);
    if (!urlValidation.ok) {
      if (
        urlValidation.reason === 'private_ip' ||
        urlValidation.reason === 'bad_scheme' ||
        urlValidation.reason === 'bad_port'
      ) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'webhook url rejected',
          status: 400,
          detail: urlValidation.detail ?? urlValidation.reason,
          instance: '/api/webhooks',
          code: urlValidation.reason,
          errors: { 'body.url': [urlValidation.detail ?? urlValidation.reason] },
        });
      }
      return problemValidation(urlValidation.detail ?? 'invalid url', {
        'body.url': [urlValidation.detail ?? urlValidation.reason],
      });
    }

    const eventsValidation = validateEvents(body.events);
    if (!eventsValidation.ok) {
      const detail = eventsValidation.unknown.length
        ? `unknown event(s): ${eventsValidation.unknown.join(', ')}`
        : 'events must be a non-empty array';
      return problemValidation(detail, {
        'body.events': eventsValidation.unknown.length
          ? [`unknown: ${eventsValidation.unknown.join(', ')}`]
          : ['must be a non-empty array of known event names'],
      });
    }

    let description: string | undefined;
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') {
        return problemValidation('description must be a string when provided', {
          'body.description': ['must be a string'],
        });
      }
      const trimmed = body.description.trim();
      if (trimmed.length > 0) {
        description = trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
      }
    }

    const webhookId = generateWebhookId();
    const signingSecret = generateSigningSecret();

    const db = getAdminDb();
    const webhookRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);

    // The secret goes to the server-only sibling, never onto the webhook
    // document — that document is client-readable by any site member.
    // See lib/webhookSecrets.server.ts.
    await writeWebhookSecret(site.siteId, webhookId, signingSecret, null, db);

    await webhookRef.set({
      schemaVersion: 1,
      url: urlValidation.url,
      hostname: urlValidation.hostname,
      events: eventsValidation.events,
      ...(description !== undefined ? { description } : {}),
      secretRotatedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: auth.userId,
      paused: false,
      deletedAt: null,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      failureCount: 0,
    });

    const createdAt = new Date().toISOString();
    emitMutation({
      kind: 'webhook_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: webhookId,
      attributes: {
        verb: 'create',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        eventCount: eventsValidation.events.length,
        hasDescription: description !== undefined,
      },
    });

    const responseBody: Record<string, unknown> = {
      id: webhookId,
      siteId: site.siteId,
      url: urlValidation.url,
      events: eventsValidation.events,
      paused: false,
      createdAt,
      signingSecret,
    };
    if (description !== undefined) responseBody.description = description;

    const response = applyAuthDeprecations(
      NextResponse.json(responseBody, { status: 201 }),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'webhooks:POST');
  }
}

export async function GET(request: NextRequest) {
  try {
    const siteIdParam = request.nextUrl.searchParams.get('siteId');
    if (!siteIdParam) {
      return problemValidation('query param `siteId` is required', {
        'query.siteId': ['required'],
      });
    }
    const site = validateSiteIdBody(siteIdParam, 'query.siteId');
    if (!site.ok) return site.response;

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'read');
    if (!auth.ok) return auth.response;

    const parsedPagination = parsePagination(request.nextUrl.searchParams, {
      defaultPageSize: DEFAULT_LIST_LIMIT,
      maxPageSize: MAX_LIST_LIMIT,
    });
    if (!parsedPagination.ok) return parsedPagination.response;
    const { pageSize, pageToken } = parsedPagination.pagination;

    const db = getAdminDb();
    const webhooksCol = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks');

    const page = await collectFilteredPage({
      pageSize,
      pageToken,
      fetchPage: async (cursor, limit) => {
        let query = webhooksCol.orderBy('createdAt', 'desc').limit(limit);
        if (cursor) {
          const cursorSnap = await webhooksCol.doc(cursor).get();
          if (cursorSnap.exists) query = query.startAfter(cursorSnap);
        }
        const snap = await query.get();
        return snap.docs;
      },
      include: (doc) => {
        const data = doc.data();
        return !data.deletedAt;
      },
    });

    const webhooks = page.docs
      .map((d) => {
        const data = d.data();
        return serializeSubscription(d.id, data);
      });

    return applyAuthDeprecations(
      NextResponse.json(withPaginationFields({ webhooks }, page.nextPageToken)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks:GET');
  }
}

function generateWebhookId(): string {
  // 18 hex = 72 bits; with the prefix, 21 chars — inside the 8-64 bound.
  return `wh_${randomBytes(WEBHOOK_ID_BYTES).toString('hex')}`;
}

function generateSigningSecret(): string {
  // 64 hex chars; `whsec_` follows the stripe convention.
  return `whsec_${randomBytes(SIGNING_SECRET_BYTES).toString('hex')}`;
}

/** Client-safe summary. `signingSecret` is only ever in create/rotate responses. */
export function serializeSubscription(
  id: string,
  data: FirebaseFirestore.DocumentData,
): {
  id: string;
  url: string;
  events: string[];
  description?: string;
  createdAt: string | null;
  updatedAt: string | null;
  paused: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: string | null;
  failureCount: number;
} {
  const description = typeof data.description === 'string' ? data.description : undefined;
  return {
    id,
    url: typeof data.url === 'string' ? data.url : '',
    events: Array.isArray(data.events) ? [...data.events] : [],
    ...(description ? { description } : {}),
    createdAt: timestampToIso(data.createdAt),
    updatedAt: timestampToIso(data.updatedAt),
    paused: Boolean(data.paused),
    lastDeliveryAt: timestampToIso(data.lastDeliveryAt),
    lastDeliveryStatus:
      typeof data.lastDeliveryStatus === 'string' ? data.lastDeliveryStatus : null,
    failureCount: typeof data.failureCount === 'number' ? data.failureCount : 0,
  };
}
