/**
 * GET    /api/webhooks/{webhookId}?siteId=...
 *   -> { id, url, events, description?, createdAt, updatedAt, paused,
 *        lastDeliveryAt, lastDeliveryStatus, failureCount }
 *
 * PATCH  /api/webhooks/{webhookId}?siteId=...
 *   { url?, events?, description?, paused? } -> the serialized subscription.
 *   Idempotency-key supported. events[] is re-validated and url re-run through
 *   the SSRF guard (DNS resolved, private ips blocked).
 *
 * DELETE /api/webhooks/{webhookId}?siteId=...
 *   -> { id, siteId, softDeleted: true, tombstoneExpiresAt }
 *   Soft delete only: stamps `deletedAt` + a 30d tombstone. The dispatcher
 *   filters on `deletedAt`, so delivery stops next tick, and delivery history
 *   lives outside this doc and survives for the full 30-day audit window.
 *
 * Scope: site:<id>:read for GET, site:<id>:write for PATCH + DELETE; all three
 * need WEBHOOK_MANAGE.
 * signingSecret is NEVER returned — only create and rotate-secret surface it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { emitMutation } from '@/lib/auditLogClient';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';
import { validateEvents } from '@/lib/webhookEvents';
import { validateWebhookUrl } from '@/lib/webhookUrl';

import {
  auditActorIdentifier,
  applyAuthDeprecations,
  readAndParseJsonBody,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../../_shared';
import { serializeSubscription } from '../route';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DESCRIPTION_LENGTH = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }

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

    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const data = snap.data();

    if (!snap.exists || !data || data.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    return applyAuthDeprecations(
      NextResponse.json(serializeSubscription(webhookId, data)),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:GET');
  }
}

interface PatchBody {
  url?: unknown;
  events?: unknown;
  description?: unknown;
  paused?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }

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

    // Site-admin action: membership + scope alone must not let a member edit a
    // subscription's url or events.
    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;

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

    const body = (parsed.body ?? {}) as PatchBody;
    const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {};

    if (body.url !== undefined) {
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
            instance: `/api/webhooks/${webhookId}`,
            code: urlValidation.reason,
            errors: { 'body.url': [urlValidation.detail ?? urlValidation.reason] },
          });
        }
        return problemValidation(urlValidation.detail ?? 'invalid url', {
          'body.url': [urlValidation.detail ?? urlValidation.reason],
        });
      }
      updates.url = urlValidation.url;
      updates.hostname = urlValidation.hostname;
    }

    if (body.events !== undefined) {
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
      updates.events = eventsValidation.events;
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return problemValidation('description must be a string when provided', {
          'body.description': ['must be a string'],
        });
      }
      const trimmed = typeof body.description === 'string' ? body.description.trim() : '';
      updates.description = trimmed ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : FieldValue.delete();
    }

    if (body.paused !== undefined) {
      if (typeof body.paused !== 'boolean') {
        return problemValidation('paused must be a boolean when provided', {
          'body.paused': ['must be a boolean'],
        });
      }
      updates.paused = body.paused;
      // the sender switches a failing webhook off with the legacy `enabled: false`;
      // dropping it leaves `paused` the one switch, and a resume gets ten fresh tries.
      updates.enabled = FieldValue.delete();
      if (!body.paused) updates.failCount = 0;
    }

    if (Object.keys(updates).length === 0) {
      return problemValidation('no updatable fields provided', {
        body: ['must include at least one of: url, events, description, paused'],
      });
    }

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const existing = snap.data();

    if (!snap.exists || !existing || existing.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    updates.updatedAt = FieldValue.serverTimestamp();
    const changedFields = Object.keys(updates).filter((field) => field !== 'updatedAt');
    await ref.update(updates);

    const refreshed = await ref.get();
    const refreshedData = refreshed.data() ?? existing;

    const response = applyAuthDeprecations(
      NextResponse.json(serializeSubscription(webhookId, refreshedData)),
      auth.scopeCheck,
    );

    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    emitMutation({
      kind: 'webhook_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: webhookId,
      attributes: {
        verb: 'update',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        changedFields,
      },
    });
    return response;
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:PATCH');
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> },
) {
  try {
    const { webhookId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }

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

    // Site-admin action: a member on the site must not be able to tombstone a
    // subscription other operators depend on.
    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const db = getAdminDb();
    const ref = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const snap = await ref.get();
    const existing = snap.data();

    if (!snap.exists || !existing) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    // Idempotent: re-return the original tombstone rather than restamping.
    if (existing.deletedAt) {
      const already =
        typeof existing.tombstoneExpiresAt === 'number'
          ? existing.tombstoneExpiresAt
          : Date.now() + TOMBSTONE_TTL_MS;
      return applyAuthDeprecations(
        NextResponse.json({
          id: webhookId,
          siteId: site.siteId,
          softDeleted: true,
          tombstoneExpiresAt: new Date(already).toISOString(),
        }),
        auth.scopeCheck,
      );
    }

    const tombstoneExpiresAt = Date.now() + TOMBSTONE_TTL_MS;
    await ref.update({
      deletedAt: FieldValue.serverTimestamp(),
      deletedBy: auth.userId,
      tombstoneExpiresAt,
      paused: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    emitMutation({
      kind: 'webhook_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: webhookId,
      attributes: {
        verb: 'delete',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        tombstoneExpiresAt,
      },
    });

    return applyAuthDeprecations(
      NextResponse.json({
        id: webhookId,
        siteId: site.siteId,
        softDeleted: true,
        tombstoneExpiresAt: new Date(tombstoneExpiresAt).toISOString(),
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]:DELETE');
  }
}
