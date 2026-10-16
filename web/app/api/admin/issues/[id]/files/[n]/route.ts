/**
 * GET /api/admin/issues/{id}/files/{n} — one screenshot or video a browser
 * attached to a dashboard issue.
 *
 * `{id}` is the issue number or its doc id; `{n}` the file's 1-based index in
 * the issue's `attachments.files`. A plain browser GET: a superadmin gets a 302
 * to a 15-minute presigned download; everyone else 403. An API key also needs
 * the superadmin-only `issue=*:read` scope. 404 when the issue or the file does
 * not exist, 410 once the files have expired (R2's lifecycle rule deletes them
 * after 30 days).
 *
 * Every download writes a blocking `global/audit_log` row naming the actor and
 * the issue. These files come only from a signed-in user, so the issue names no
 * site and no site's audit log gets a row. No row, no url (503).
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
import { generateCorrelationId, writeGlobalAuditEntryBlocking } from '@/lib/auditLog.server';
import { Capability } from '@/lib/capabilities';
import { getAdminDb } from '@/lib/firebase-admin';
import { headIssueLogs, presignIssueLogsDownload } from '@/lib/issueLogsStorage.server';
import { findIssue, issueFiles } from '@/lib/issues.server';
import logger from '@/lib/logger';

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const N_RE = /^[1-9]\d{0,8}$/;

interface RouteParams {
  params: Promise<{ id: string; n: string }>;
}

interface IssueDoc {
  number?: unknown;
  files?: unknown;
  filesExpireAt?: Timestamp;
}

function gone(): NextResponse {
  return problem({
    type: ProblemType.NotFound,
    title: 'gone',
    status: 410,
    code: 'issue_attachment_expired',
    detail: 'the files attached to this issue have expired',
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    // superadmin only; an api key also needs the superadmin-only issue=*:read scope
    const auth = await requirePlatformAuthAndScope(request, 'issue', 'read');
    if (!auth.ok) return auth.response;

    const { id, n } = await params;
    if (!ID_RE.test(id)) {
      return problemValidation('invalid issue id', { 'path.id': ['letters, digits, underscore, hyphen only'] });
    }

    const snap = await findIssue(getAdminDb(), id);
    const issue = snap?.data() as IssueDoc | undefined;
    const file = N_RE.test(n) ? issueFiles(issue?.files).find((f) => f.index === Number(n)) : undefined;
    if (!snap || !issue || !file) return problemNotFound('no such file is attached to this issue');

    const expiresAt = issue.filesExpireAt;
    if (typeof expiresAt?.toMillis !== 'function' || expiresAt.toMillis() <= Date.now()) {
      return gone();
    }
    if (!(await headIssueLogs(file.key))) return gone();

    const correlationId = generateCorrelationId();
    try {
      await writeGlobalAuditEntryBlocking({
        correlationId,
        actor: {
          type: 'user',
          userId: auth.userId,
          role: 'superadmin',
          ...(auth.auth.keyContext ? { apiKeyId: auth.auth.keyContext.keyId } : {}),
        },
        capability: Capability.ISSUE_MANAGE,
        target: { kind: 'issue', id: snap.id },
        outcome: 'allow',
        metadata: {
          route: request.nextUrl.pathname,
          method: 'GET',
          action: 'issue_file_download',
          issueId: snap.id,
          file: file.index,
          kind: file.kind,
        },
      });
    } catch (err) {
      logger.error('[admin/issues/files] audit write failed; refusing the download', {
        context: 'admin/issues/files',
        data: { correlationId, err: err instanceof Error ? err.message : String(err) },
      });
      return problem({
        type: ProblemType.ServiceUnavailable,
        title: 'service unavailable',
        status: 503,
        detail: 'audit log unavailable; refusing privileged action',
      });
    }

    const name = typeof issue.number === 'number' ? issue.number : snap.id;
    const url = await presignIssueLogsDownload(file.key, `owlette-issue-${name}-${file.index}.${file.ext}`);
    const response = NextResponse.redirect(url, 302);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (err) {
    return problemFromError(err, 'admin/issues/[id]/files/[n]:GET');
  }
}
