/**
 * GET /api/webhooks/{webhookId}/deliveries/{deliveryId}?siteId=...
 *   output: { id, webhookId, siteId, event, state,
 *             request: { method, url, headers, body },
 *             response: { status, headers, body, durationMs } | null,
 *             attempt, nextAttemptAt, createdAt, completedAt, lastError }
 *
 * Scope: site:<id>:read, plus WEBHOOK_MANAGE. roost public api wave 6.6.
 *
 * `deliveryId` is the firestore record id from the list response
 * ({publicDeliveryId}__{subscriptionId}), opaque to callers. The embedded
 * `subscriptionId` is checked against the path's webhookId so a caller can't cross-read
 * another subscription's delivery by id.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  problemFromError,
  problemNotFound,
  problemValidation,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';

import {
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../../../../_shared';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DELIVERY_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const DELIVERIES_COLLECTION = 'webhook_deliveries';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ webhookId: string; deliveryId: string }> },
) {
  try {
    const { webhookId, deliveryId } = await params;
    if (!WEBHOOK_ID_RE.test(webhookId)) {
      return problemValidation(
        'webhookId must be 8-64 chars: letters, digits, underscore, hyphen',
        { 'path.webhookId': ['invalid format'] },
      );
    }
    if (!DELIVERY_ID_RE.test(deliveryId)) {
      return problemValidation('deliveryId format invalid', {
        'path.deliveryId': ['invalid format'],
      });
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

    // Confirm subscription exists + belongs to this site.
    const webhookRef = db
      .collection('sites')
      .doc(site.siteId)
      .collection('webhooks')
      .doc(webhookId);
    const webhookSnap = await webhookRef.get();
    const webhookData = webhookSnap.data();
    if (!webhookSnap.exists || !webhookData || webhookData.deletedAt) {
      return problemNotFound(`webhook ${webhookId} not found on site ${site.siteId}`);
    }

    const deliverySnap = await db
      .collection(DELIVERIES_COLLECTION)
      .doc(deliveryId)
      .get();
    const data = deliverySnap.data();
    if (!deliverySnap.exists || !data) {
      return problemNotFound(`delivery ${deliveryId} not found`);
    }

    // Cross-subscription read guard: the doc id is opaque but guessable/replayable from
    // another webhook on the same site, so verify the embedded subscriptionId.
    if (typeof data.subscriptionId !== 'string' || data.subscriptionId !== webhookId) {
      return problemNotFound(`delivery ${deliveryId} not found for webhook ${webhookId}`);
    }
    if (typeof data.siteId !== 'string' || data.siteId !== site.siteId) {
      return problemNotFound(`delivery ${deliveryId} not found on site ${site.siteId}`);
    }

    const request_ = {
      method: 'POST' as const,
      url: typeof data.url === 'string' ? data.url : webhookData.url ?? '',
      headers:
        data.headers && typeof data.headers === 'object'
          ? (data.headers as Record<string, string>)
          : {},
      body: typeof data.canonicalBody === 'string' ? data.canonicalBody : '',
    };

    const response_ =
      typeof data.lastStatus === 'number'
        ? {
            status: data.lastStatus as number,
            headers:
              data.responseHeaders && typeof data.responseHeaders === 'object'
                ? (data.responseHeaders as Record<string, string>)
                : {},
            body: typeof data.responseBody === 'string' ? data.responseBody : '',
            durationMs:
              typeof data.durationMs === 'number' ? (data.durationMs as number) : null,
          }
        : null;

    return applyAuthDeprecations(
      NextResponse.json({
        id: deliverySnap.id,
        webhookId,
        siteId: site.siteId,
        event: typeof data.event === 'string' ? data.event : null,
        state:
          typeof data.state === 'string'
            ? (data.state as 'pending' | 'succeeded' | 'failed')
            : 'pending',
        request: request_,
        response: response_,
        attempt: typeof data.attempt === 'number' ? data.attempt : 0,
        nextAttemptAt:
          data.state === 'pending' && typeof data.nextAttemptAt === 'number'
            ? new Date(data.nextAttemptAt).toISOString()
            : null,
        createdAt:
          typeof data.createdAt === 'number'
            ? new Date(data.createdAt).toISOString()
            : null,
        completedAt:
          typeof data.completedAt === 'number'
            ? new Date(data.completedAt).toISOString()
            : null,
        lastError: typeof data.lastError === 'string' ? data.lastError : null,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]/deliveries/[deliveryId]:GET');
  }
}
