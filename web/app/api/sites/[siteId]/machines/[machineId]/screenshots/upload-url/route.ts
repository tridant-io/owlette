/**
 * POST /api/sites/{siteId}/machines/{machineId}/screenshots/upload-url
 *
 * Called by the agent mid-`capture_screenshot`: returns a 5-minute v4-signed PUT url plus the
 * canonical storage path so the binary goes straight to Firebase Storage — a multi-MB image
 * never proxies through Next.js. The agent writes the path into its command result, and the
 * GET status route re-signs a 1-hour read URL on each poll.
 *
 * Auth: `machine=<id>:write` (api-key) or site membership; the agent's own Firebase ID token
 * carries uid + site_id and resolves through `requireMachineAuthAndScope` like any caller.
 * Idempotency deliberately not required — every call mints a fresh single-use url and path.
 * Rate limited per machine, inside the handler once auth has resolved the machine: every
 * agent screenshot — on-demand, crash and live view — is minted here, so an agent stuck in a
 * capture loop, or a leaked machine credential, cannot drive it unbounded. Not per client ip:
 * behind Cloudflare that is the site's NAT egress address, shared by every machine at the
 * site, so a per-ip budget was a per-site one. The ceiling (`screenshotUploadRateLimit`,
 * 1000/hr) sits above the talon visual-check cadence of one per five seconds per machine
 * (720/hr): the fielded agent raises on a 429 with no retry, so a normal fleet must never
 * reach it. Unauthenticated floods are bounded by the 401 in `requireMachineAuthAndScope`,
 * which signs nothing and touches no storage.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';
import { issueScreenshotUploadUrl } from '@/lib/screenshotStorage.server';
import { checkRateLimit, screenshotUploadRateLimit } from '@/lib/rateLimit';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);

interface UploadUrlBody {
  contentType?: unknown;
}

async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
    if (!auth.ok) return auth.response;

    const rateLimitKey = `screenshot_upload:${siteId}:${machineId}`;
    const rateResult = await checkRateLimit(screenshotUploadRateLimit, rateLimitKey);
    if (!rateResult.success) {
      console.warn(`[screenshots/upload-url] rate limited: ${rateLimitKey}`);
      return rateLimitedResponse(rateResult, 'endpoint-rate');
    }

    // Body is optional and only `contentType` is honored, but still parsed so a malformed
    // payload 400s instead of being silently ignored.
    let body: UploadUrlBody = {};
    const text = await request.text().catch(() => '');
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as UploadUrlBody;
      } catch {
        return problemValidation('request body is not valid json');
      }
    }

    let contentType = 'image/png';
    if (body.contentType !== undefined && body.contentType !== null) {
      if (
        typeof body.contentType !== 'string' ||
        !ALLOWED_CONTENT_TYPES.has(body.contentType)
      ) {
        return problemValidation(
          'contentType must be image/png or image/jpeg when provided',
          {
            'body.contentType': ['must be image/png or image/jpeg'],
          },
        );
      }
      contentType = body.contentType;
    }

    const issued = await issueScreenshotUploadUrl(siteId, machineId, contentType);

    return applyRateLimitCounters(
      applyAuthDeprecations(
        NextResponse.json({
          ok: true,
          data: {
            uploadUrl: issued.uploadUrl,
            storagePath: issued.storagePath,
            contentType,
            expiresAt: issued.expiresAt,
          },
        }),
        auth.scopeCheck,
      ),
      rateResult,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/screenshots/upload-url:POST',
    );
  }
}

export const POST = handlePost;
