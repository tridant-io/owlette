/**
 * GET/PATCH /api/admin/issues/{id}
 *
 * `{id}` is the issue number or its doc id. GET returns the issue; PATCH sets its
 * triage status and, optionally, a note. Superadmin only; an API key also needs the
 * superadmin-only `issue=*:read` (GET) or `issue=*:write` (PATCH) scope. A PATCH
 * writes a blocking `global/audit_log` row before it changes anything.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problemFromError, problemNotFound, problemValidation } from '@/lib/apiErrors';
import { parseJsonBody, requirePlatformAuthAndScope } from '@/app/api/_shared';
import { authorizedPlatformHandler } from '@/lib/authorizedHandler.server';
import { getAdminDb } from '@/lib/firebase-admin';
import { setIssueStatus } from '@/lib/actions/setIssueStatus.server';
import { ISSUE_NOTE_MAX, ISSUE_STATUSES, type IssueStatus } from '@/lib/issues';
import { findIssue, serializeIssue } from '@/lib/issues.server';

type RouteParams = {
  id: string;
} & Record<string, string | undefined>;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requirePlatformAuthAndScope(request, 'issue', 'read');
    if (!auth.ok) return auth.response;

    const { id } = await params;
    const snap = await findIssue(getAdminDb(), id);
    if (!snap) return problemNotFound('issue not found');

    return NextResponse.json(serializeIssue(snap));
  } catch (err) {
    return problemFromError(err, 'admin/issues/[id]:GET');
  }
}

export const PATCH = authorizedPlatformHandler<RouteParams>({
  capability: 'ISSUE_MANAGE',
  targetKind: 'issue',
  targetIdParam: 'id',
  apiKeyScope: { resource: 'issue', permission: 'write' },
})(async (request, ctx, routeContext) => {
  try {
    const { id } = await routeContext!.params;

    const parsed = await parseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as { status?: unknown; note?: unknown };

    if (!ISSUE_STATUSES.includes(body.status as IssueStatus)) {
      return problemValidation(`status must be one of ${ISSUE_STATUSES.join(', ')}`, {
        'body.status': ['invalid value'],
      });
    }
    const status = body.status as IssueStatus;

    let note: string | undefined;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string' || body.note.trim().length > ISSUE_NOTE_MAX) {
        return problemValidation(`note must be a string of at most ${ISSUE_NOTE_MAX} characters`, {
          'body.note': ['invalid value'],
        });
      }
      note = body.note.trim();
    }

    const issue = await setIssueStatus({ actor: ctx.actor, idOrNumber: id, status, note });
    if (!issue) return problemNotFound('issue not found');

    return NextResponse.json(issue);
  } catch (err) {
    return problemFromError(err, 'admin/issues/[id]:PATCH');
  }
});
