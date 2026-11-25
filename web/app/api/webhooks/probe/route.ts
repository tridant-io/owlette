/**
 * POST /api/webhooks/probe?siteId=...
 *   body   { url, event, payload?, signingSecret? }
 *   output { status, durationMs, deliveryId, event, requestBody (the exact
 *            bytes posted), signature, signingSecret (echoed or minted),
 *            responseBody? }
 *
 * Stateless — no subscription is created or touched. It exists so users can
 * test a signature verifier against a live roost-signed payload before wiring
 * a real webhook. The url goes through the full SSRF guard; the event is
 * checked against `ROOST_WEBHOOK_EVENTS`, and an unknown event with no
 * `payload` is a 400.
 *
 * Signature: stripe-style `Roost-Signature: t=<unix>,v1=<hex>`, matching
 * `functions/src/webhookDispatch.ts`. v1 covers `"<t>.<canonicalBody>"`, so
 * the timestamp is signed and receivers can enforce the 5-minute tolerance.
 * A redirect is returned as the status, never followed.
 *
 * Scope: site:<id>:write, so probe firings are auditable, plus WEBHOOK_MANAGE
 * and `webhookProbeRateLimit` per user.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  problem,
  problemFromError,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { checkRateLimit, webhookProbeRateLimit } from '@/lib/rateLimit';
import { isValidWebhookEvent } from '@/lib/webhookEvents';
import { signPayload } from '@/lib/webhookSignature';
import { validateWebhookUrl } from '@/lib/webhookUrl';
import { rateLimitedResponse } from '@/lib/withRateLimit';

import {
  applyAuthDeprecations,
  parseJsonBody,
  requireSiteAuthAndScope,
  requireWebhookManageCapability,
  validateSiteIdBody,
} from '../../_shared';

export const runtime = 'nodejs';

const PROBE_TIMEOUT_MS = 10_000;
const SIGNING_SECRET_BYTES = 32;

const CANNED_PAYLOADS: Record<string, (siteId: string) => Record<string, unknown>> = {
  'version.published': (siteId) => ({
    roostId: 'rst_synthetic_01',
    versionId: 'vrs_synthetic_01',
    versionNumber: 1,
    description: null,
    siteId,
    totalSize: 123456,
    totalFiles: 3,
    createdBy: 'roost-probe',
  }),
  'version.rolled_back': (siteId) => ({
    roostId: 'rst_synthetic_01',
    siteId,
    fromVersion: 'vrs_synthetic_02',
    toVersion: 'vrs_synthetic_01',
    triggeredBy: 'roost-probe',
  }),
  'deployment.started': (siteId) => ({
    roostId: 'rst_synthetic_01',
    rolloutId: 'rollout_synthetic_01',
    siteId,
    stage: 'started',
  }),
  'deployment.completed': (siteId) => ({
    roostId: 'rst_synthetic_01',
    rolloutId: 'rollout_synthetic_01',
    siteId,
    stage: 'complete',
    succeeded: 10,
    failed: 0,
  }),
  'deployment.failed': (siteId) => ({
    roostId: 'rst_synthetic_01',
    rolloutId: 'rollout_synthetic_01',
    siteId,
    stage: 'aborted',
    abortReason: 'canary_failure_rate_exceeded',
    succeeded: 3,
    failed: 7,
  }),
  'machine.online': (siteId) => ({
    siteId,
    machineId: 'DESKTOP-SYNTHETIC',
    lastHeartbeat: new Date().toISOString(),
  }),
  'machine.offline': (siteId) => ({
    siteId,
    machineId: 'DESKTOP-SYNTHETIC',
    lastHeartbeat: new Date().toISOString(),
  }),
  'chunk.garbage_collected': (siteId) => ({
    siteId,
    hash: 'a'.repeat(64),
    sizeBytes: 4 * 1024 * 1024,
  }),
  'chunk.verify_failed': (siteId) => ({
    siteId,
    hash: 'a'.repeat(64),
    expectedDigest: 'a'.repeat(64),
    actualDigest: 'b'.repeat(64),
  }),
  'quota.warning': (siteId) => ({
    siteId,
    tier: 'pro',
    usedBytes: 80 * 1024 * 1024 * 1024,
    limitBytes: 100 * 1024 * 1024 * 1024,
    threshold: 0.8,
  }),
  'quota.exceeded': (siteId) => ({
    siteId,
    tier: 'pro',
    usedBytes: 100 * 1024 * 1024 * 1024,
    limitBytes: 100 * 1024 * 1024 * 1024,
  }),
  'api_key.used': (siteId) => ({
    siteId,
    keyId: 'key_synthetic_01',
    keyPrefix: 'owk_live_abc',
    ip: '203.0.113.42',
    userAgent: 'roost-probe',
    firstUseFromIp: true,
  }),
  'api_key.expired': (siteId) => ({
    siteId,
    keyId: 'key_synthetic_01',
    keyPrefix: 'owk_live_abc',
    name: 'synthetic-probe-key',
    expiresAt: new Date().toISOString(),
  }),
};

interface ProbeBody {
  url?: unknown;
  event?: unknown;
  payload?: unknown;
  signingSecret?: unknown;
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

    const capabilityError = await requireWebhookManageCapability(auth.auth, site.siteId);
    if (capabilityError) return capabilityError;

    const rateResult = await checkRateLimit(webhookProbeRateLimit, `webhook_probe:${auth.userId}`);
    if (!rateResult.success) return rateLimitedResponse(rateResult, 'endpoint-rate');

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as ProbeBody;

    const urlValidation = await validateWebhookUrl(body.url);
    if (!urlValidation.ok) {
      if (
        urlValidation.reason === 'private_ip' ||
        urlValidation.reason === 'bad_scheme' ||
        urlValidation.reason === 'bad_port'
      ) {
        return problem({
          type: ProblemType.ValidationFailed,
          title: 'probe url rejected',
          status: 400,
          detail: urlValidation.detail ?? urlValidation.reason,
          instance: '/api/webhooks/probe',
          code: urlValidation.reason,
          errors: { 'body.url': [urlValidation.detail ?? urlValidation.reason] },
        });
      }
      return problemValidation(urlValidation.detail ?? 'invalid url', {
        'body.url': [urlValidation.detail ?? urlValidation.reason],
      });
    }

    if (typeof body.event !== 'string' || !isValidWebhookEvent(body.event)) {
      return problemValidation(
        'event must be a known roost webhook event name',
        { 'body.event': ['unknown or missing event'] },
      );
    }
    const event = body.event;

    // User-supplied or canned.
    let payload: Record<string, unknown>;
    if (body.payload !== undefined && body.payload !== null) {
      if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
        return problemValidation('payload must be a plain object when provided', {
          'body.payload': ['must be a JSON object'],
        });
      }
      payload = body.payload as Record<string, unknown>;
    } else {
      const canned = CANNED_PAYLOADS[event];
      if (!canned) {
        return problemValidation(
          `event '${event}' has no canned payload — supply body.payload`,
          { 'body.payload': ['required for this event type'] },
        );
      }
      payload = canned(site.siteId);
    }

    // User-provided or minted; either way it comes back in the response.
    let signingSecret: string;
    if (body.signingSecret !== undefined && body.signingSecret !== null) {
      if (typeof body.signingSecret !== 'string' || body.signingSecret.length < 32) {
        return problemValidation(
          'signingSecret must be a string ≥ 32 chars when provided',
          { 'body.signingSecret': ['must be a string ≥ 32 chars'] },
        );
      }
      signingSecret = body.signingSecret;
    } else {
      signingSecret = `whsec_${randomBytes(SIGNING_SECRET_BYTES).toString('hex')}`;
    }

    const occurredAt = new Date().toISOString();
    const envelope = {
      id: `evt_probe_${randomBytes(8).toString('hex')}`,
      event,
      occurredAt,
      siteId: site.siteId,
      data: payload,
    };
    const canonicalBody = JSON.stringify(sortForCanonical(envelope));
    const signature = signPayload(canonicalBody, signingSecret);
    const deliveryId = randomUUID();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Roost-Event': event,
      'Roost-Delivery': deliveryId,
      'Roost-Signature': signature,
      'User-Agent': 'roost-probe/1.0',
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const t0 = Date.now();
    let status: number | null = null;
    let responseBody = '';
    let networkError: string | null = null;
    try {
      const resp = await fetch(urlValidation.url, {
        method: 'POST',
        headers,
        body: canonicalBody,
        redirect: 'manual',
        signal: controller.signal,
      });
      status = resp.status;
      try {
        responseBody = (await resp.text()).slice(0, 2048);
      } catch {
        responseBody = '';
      }
    } catch (err) {
      networkError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - t0;

    return applyAuthDeprecations(
      NextResponse.json({
        status,
        durationMs,
        deliveryId,
        event,
        requestBody: canonicalBody,
        signature,
        signingSecret,
        responseBody: responseBody || undefined,
        networkError: networkError ?? undefined,
      }),
      auth.scopeCheck,
    );
  } catch (err) {
    return problemFromError(err, 'webhooks/probe:POST');
  }
}

function sortForCanonical(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortForCanonical);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v as Record<string, unknown>).sort();
  for (const k of keys) out[k] = sortForCanonical((v as Record<string, unknown>)[k]);
  return out;
}
