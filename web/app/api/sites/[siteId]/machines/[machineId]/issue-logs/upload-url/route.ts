/**
 * POST /api/sites/{siteId}/machines/{machineId}/issue-logs/upload-url
 *
 * Called by the agent when a person submits an issue with "attach logs" ticked:
 * returns a 15-minute presigned PUT for one zip of the machine's logs, and the
 * key the agent then names as `logsKey` in `POST /api/bug-report`. The zip goes
 * straight to R2 and never proxies through Next.js.
 *
 * Body: `{size}`, the zip's exact byte count (1..50 MiB). content-length is
 * signed into the url, so R2 refuses a body of any other size.
 * 200: `{uploadUrl, key, expiresIn}`.
 *
 * Only this machine's own agent: a site member must not be able to fill the
 * bucket with zips that read as coming from a machine. Rate limited per machine,
 * not per ip — every machine at a site shares the site's NAT egress address.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problemForbidden,
  problemFromError,
  problemValidation,
} from '@/lib/apiErrors';
import { requireMachineAuthAndScope } from '../../../../../../_shared';
import {
  ISSUE_LOGS_MAX_BYTES,
  ISSUE_LOGS_URL_TTL_SECONDS,
  issueLogsKey,
  presignIssueLogsUpload,
} from '@/lib/issueLogsStorage.server';
import { checkRateLimit, issueLogsUploadRateLimit } from '@/lib/rateLimit';
import { resolveAgentPrincipal } from '@/lib/sitePolicy.server';
import { applyRateLimitCounters, rateLimitedResponse } from '@/lib/withRateLimit';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string }>;
}

const NOT_THIS_AGENT = "only this machine's own agent can upload its logs";

async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId } = await params;

    const agent = await resolveAgentPrincipal(request, siteId, machineId);
    if (agent?.matched === 'mismatch') return problemForbidden(NOT_THIS_AGENT);
    if (!agent) {
      // not an agent: machine auth answers a missing, expired or bad credential
      // (401) or a site the caller cannot see (404); whoever it lets through is a
      // person or an api key, and still not this machine's agent
      const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'write');
      if (!auth.ok) return auth.response;
      return problemForbidden(NOT_THIS_AGENT);
    }

    const rateLimitKey = `issue_logs_upload:${siteId}:${machineId}`;
    const rateResult = await checkRateLimit(issueLogsUploadRateLimit, rateLimitKey);
    if (!rateResult.success) {
      console.warn(`[issue-logs/upload-url] rate limited: ${rateLimitKey}`);
      return rateLimitedResponse(rateResult, 'endpoint-rate');
    }

    let body: { size?: unknown };
    try {
      body = (await request.json()) as { size?: unknown };
    } catch {
      return problemValidation('request body is not valid json');
    }

    const size = body?.size;
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > ISSUE_LOGS_MAX_BYTES) {
      return problemValidation(`size must be an integer from 1 to ${ISSUE_LOGS_MAX_BYTES}`, {
        'body.size': [`integer, 1..${ISSUE_LOGS_MAX_BYTES} bytes`],
      });
    }

    const key = issueLogsKey(siteId, machineId);
    const uploadUrl = await presignIssueLogsUpload(key, size);

    return applyRateLimitCounters(
      NextResponse.json({ uploadUrl, key, expiresIn: ISSUE_LOGS_URL_TTL_SECONDS }),
      rateResult,
    );
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/issue-logs/upload-url:POST',
    );
  }
}

export const POST = handlePost;
