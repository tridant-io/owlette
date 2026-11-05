/**
 * GET /api/admin/issues/{id}/logs — the logs zip a machine attached to an issue.
 *
 * `{id}` is the issue number or its doc id. Linked from the issue's alert email,
 * so it is a plain browser GET: a superadmin gets a 302 to a 15-minute presigned
 * download; everyone else 403. An API key also needs the superadmin-only
 * `issue=*:read` scope. 404 when the issue does not exist or carries no logs,
 * 410 once they have expired (R2's lifecycle rule deletes the object after 30 days).
 *
 * Every download writes a blocking `global/audit_log` row naming the actor and
 * the issue, and, when the issue names a site, a row in that site's own
 * `sites/{siteId}/audit_log`, which that site's admins can read. The site row names the
 * actor only as `system:owlette_support`; the two rows share a correlationId.
 * No rows, no url (503).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import type { Timestamp } from 'firebase-admin/firestore';
import {
  problem,
  problemFromError,
  problemNotFound,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { requirePlatformAuthAndScope } from '@/app/api/_shared';
import {
  generateCorrelationId,
  writeAuditEntryBlocking,
  writeGlobalAuditEntryBlocking,
} from '@/lib/auditLog.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { headIssueLogs, presignIssueLogsDownload } from '@/lib/issueLogsStorage.server';
import { findIssue, hostFromPageUrl } from '@/lib/issues.server';
import logger from '@/lib/logger';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface IssueDoc {
  siteId?: string | null;
  machineId?: string | null;
  pageUrl?: string;
  logs?: { key?: unknown; expiresAt?: Timestamp };
}

function gone(): NextResponse {
  return problem({
    type: ProblemType.NotFound,
    title: 'gone',
    status: 410,
    code: 'issue_logs_expired',
    detail: 'the logs attached to this issue have expired',
  });
}

/** `owlette-issue-<hostname>-<YYYY-MM-DD>.zip`; it may hold screenshots as well as logs */
function downloadName(host: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `owlette-issue-${host || 'machine'}-${day}.zip`;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // superadmin only; an api key also needs the superadmin-only issue=*:read scope
    const auth = await requirePlatformAuthAndScope(request, 'issue', 'read');
    if (!auth.ok) return auth.response;

    const { id } = await params;
    if (!ID_RE.test(id)) {
      return problemValidation('invalid issue id', { 'path.id': ['letters, digits, underscore, hyphen only'] });
    }

    const snap = await findIssue(getAdminDb(), id);
    const issue = snap?.data() as IssueDoc | undefined;
    const key = issue?.logs?.key;
    if (!snap || !issue || typeof key !== 'string') {
      return problemNotFound('no logs are attached to this issue');
    }

    const expiresAt = issue.logs?.expiresAt;
    if (typeof expiresAt?.toMillis !== 'function' || expiresAt.toMillis() <= Date.now()) {
      return gone();
    }
    if (!(await headIssueLogs(key))) return gone();

    const correlationId = generateCorrelationId();
    const machineId = issue.machineId ?? 'unknown';
    const host = hostFromPageUrl(issue.pageUrl);
    try {
      const globalRow = writeGlobalAuditEntryBlocking({
        correlationId,
        actor: {
          type: 'user',
          userId: auth.userId,
          role: 'superadmin',
          ...(auth.auth.keyContext ? { apiKeyId: auth.auth.keyContext.keyId } : {}),
        },
        // a support download is a read of one machine's data, the same class as its screen
        capability: Capability.MACHINE_VIEW,
        target: { kind: 'machine', id: machineId },
        outcome: 'allow',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'GET',
          action: 'issue_logs_download',
          issueId: snap.id,
          siteId: issue.siteId ?? null,
        },
      });
      // older reports carry no siteId; their only record is the global row
      const siteRow = issue.siteId
        ? writeAuditEntryBlocking(issue.siteId, {
            correlationId,
            actor: { type: 'system', name: 'owlette_support' },
            capability: Capability.MACHINE_VIEW,
            target: { kind: 'machine', id: machineId, machineId },
            outcome: 'allow',
            metadata: {
              action: 'issue_logs_download',
              issueId: snap.id,
              ...(host ? { machineName: host } : {}),
            },
          })
        : undefined;
      await Promise.all([globalRow, siteRow]);
    } catch (err) {
      logger.error('[admin/issues/logs] audit write failed; refusing the download', {
        context: 'admin/issues/logs',
        data: { correlationId, err: err instanceof Error ? err.message : String(err) },
      });
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'service unavailable',
        status: 503,
        detail: 'audit log unavailable; refusing privileged action',
      });
    }

    const url = await presignIssueLogsDownload(key, downloadName(host));
    const response = NextResponse.redirect(url, 302);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (err) {
    return problemFromError(err, 'admin/issues/[id]/logs:GET');
  }
}
