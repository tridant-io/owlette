/**
 * POST /api/webhooks/{webhookId}/deliveries/{deliveryId}/retry?siteId=...
 *   output: { id, webhookId, siteId, retryOf, state: 'pending', nextAttemptAt }
 *
 * Inserts a fresh `webhook_deliveries` record with `state: 'pending'` and
 * `nextAttemptAt: now`; the retry pump (functions/src/webhookDispatch.ts) picks it up on
 * its next tick. Re-signs with the subscription's CURRENT signingSecret so a rotation
 * since the original delivery is honored. The public `X-owlette-Delivery-Id` header stays
 * identical to the original so receivers that dedup on it see the same event, and
 * `attempt: 0` gives the retry a full backoff budget even if the original exhausted its.
 *
 * Scope: site:<id>:write, plus WEBHOOK_MANAGE. roost public api wave 6.7.
 */

import { randomBytes } from 'node:crypto';

import { emitMutation } from '@/lib/auditLogClient';
import { signPayload } from '@/lib/webhookSignature';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { readWebhookSecrets } from '@/lib/webhookSecrets.server';
import { checkIdempotency, saveIdempotency } from '@/lib/idempotency';

import {
  auditActorIdentifier,
  applyAuthDeprecations,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../../../../../_shared';

export const runtime = 'nodejs';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DELIVERY_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
const DELIVERIES_COLLECTION = 'webhook_deliveries';

export async function POST(
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

    const auth = await requireSiteAuthAndScope(request, site.siteId, 'write');
    if (!auth.ok) return auth.response;

    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const rawBody = await request.text().catch(() => '');
    const idem = await checkIdempotency(
      request,
      {
        userId: auth.userId,
        environment: auth.auth.keyContext?.environment ?? 'unknown',
      },
      rawBody,
    );
    if (idem.mode === 'invalid' || idem.mode === 'mismatch' || idem.mode === 'replay') {
      return idem.response;
    }

    const db = getAdminDb();

    // Load the subscription. Must exist + not be soft-deleted; we also
    // need its current `signingSecret` to re-sign the retry.
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
    // Server-only sibling first; legacy in-document field as the pre-migration fallback.
    const storedSecrets = await readWebhookSecrets(site.siteId, webhookId);
    const currentSecret =
      storedSecrets.signingSecret ??
      (typeof webhookData.signingSecret === 'string' ? webhookData.signingSecret : null);
    if (!currentSecret) {
      return problem({
        type: ProblemType.Internal,
        title: 'webhook missing signing secret',
        status: 500,
        detail: 'subscription has no stored signing secret; rotate the secret and try again',
        instance: `/api/webhooks/${webhookId}`,
      });
    }

    // Load the original delivery — cross-subscription + cross-site guards.
    const originalSnap = await db.collection(DELIVERIES_COLLECTION).doc(deliveryId).get();
    const original = originalSnap.data();
    if (!originalSnap.exists || !original) {
      return problemNotFound(`delivery ${deliveryId} not found`);
    }
    if (typeof original.subscriptionId !== 'string' || original.subscriptionId !== webhookId) {
      return problemNotFound(`delivery ${deliveryId} not found for webhook ${webhookId}`);
    }
    if (typeof original.siteId !== 'string' || original.siteId !== site.siteId) {
      return problemNotFound(`delivery ${deliveryId} not found on site ${site.siteId}`);
    }

    const canonicalBody =
      typeof original.canonicalBody === 'string' ? original.canonicalBody : null;
    const event = typeof original.event === 'string' ? original.event : null;
    const targetUrl =
      typeof original.url === 'string' && original.url
        ? original.url
        : typeof webhookData.url === 'string'
          ? webhookData.url
          : null;
    if (!canonicalBody || !event || !targetUrl) {
      return problem({
        type: ProblemType.Internal,
        title: 'original delivery is malformed',
        status: 500,
        detail: 'original delivery record is missing required fields; retry not possible',
        instance: `/api/webhooks/${webhookId}/deliveries/${deliveryId}`,
      });
    }

    // Keep the public delivery id (stable per content) so receivers dedup the retry against
    // the original; the Firestore doc id is suffixed to avoid colliding with that record.
    const originalHeaders =
      original.headers && typeof original.headers === 'object'
        ? (original.headers as Record<string, string>)
        : {};
    const publicDeliveryId =
      typeof originalHeaders['Roost-Delivery'] === 'string'
        ? originalHeaders['Roost-Delivery']
        : typeof originalHeaders['X-owlette-Delivery-Id'] === 'string'
          ? originalHeaders['X-owlette-Delivery-Id']
          : deliveryId.split('__')[0] ?? deliveryId;

    const retrySuffix = randomBytes(4).toString('hex');
    const newRecordId = `${deliveryId}__retry_${retrySuffix}`;
    const now = Date.now();
    const signature = signPayload(canonicalBody, currentSecret, now);

    const retryRecord = {
      id: newRecordId,
      subscriptionId: webhookId,
      siteId: site.siteId,
      url: targetUrl,
      canonicalBody,
      headers: {
        'Content-Type': 'application/json',
        'Roost-Event': event,
        'Roost-Delivery': publicDeliveryId,
        'Roost-Signature': signature,
      },
      event,
      attempt: 0,
      state: 'pending' as const,
      nextAttemptAt: now,
      createdAt: now,
      secret: currentSecret,
      retryOf: deliveryId,
      retryOfPublicId: publicDeliveryId,
      retriedBy: auth.userId,
      retriedAt: now,
    };

    await db.collection(DELIVERIES_COLLECTION).doc(newRecordId).set(retryRecord);

    emitMutation({
      kind: 'webhook_mutated',
      siteId: site.siteId,
      actor: auditActorIdentifier(auth.auth),
      targetId: webhookId,
      attributes: {
        verb: 'retry_delivery',
        endpoint: request.nextUrl.pathname,
        method: request.method,
        deliveryId,
        retryDeliveryId: newRecordId,
        event,
      },
    });

    const response = applyAuthDeprecations(
      NextResponse.json(
        {
          id: newRecordId,
          webhookId,
          siteId: site.siteId,
          retryOf: deliveryId,
          state: 'pending',
          nextAttemptAt: new Date(now).toISOString(),
        },
        { status: 202 },
      ),
      auth.scopeCheck,
    );
    if (idem.mode === 'proceed') await saveIdempotency(idem.token, response);
    return response;
  } catch (err) {
    return problemFromError(err, 'webhooks/[webhookId]/deliveries/[deliveryId]/retry:POST');
  }
}
