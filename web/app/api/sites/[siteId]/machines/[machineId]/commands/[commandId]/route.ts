/**
 * GET /api/sites/{siteId}/machines/{machineId}/commands/{commandId}
 *
 * Poll a queued command. The status lookup (pending/completed merge, progress
 * markers, the screenshot's fresh signed read url) is `lookupCommandStatus`,
 * shared with the fleet's call reader.
 *
 * Auth: `machine=<id>:read` (api key) OR site membership (session/id-token).
 * api-sprint wave 2 — track 2A (machine-api MVP).
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { problem, problemFromError, ProblemType } from '@/lib/apiErrors';
import { getAdminDb } from '@/lib/firebase-admin';
import { timestampToIso } from '@/lib/firestoreTime.server';
import { COMMAND_ID_RE, lookupCommandStatus } from '@/lib/commandStatus.server';
import {
  applyAuthDeprecations,
  requireMachineAuthAndScope,
} from '../../../../../../_shared';

interface RouteParams {
  params: Promise<{ siteId: string; machineId: string; commandId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { siteId, machineId, commandId } = await params;

    if (!COMMAND_ID_RE.test(commandId)) {
      return problem({
        type: ProblemType.ValidationFailed,
        title: 'invalid commandId',
        status: 400,
        detail: 'commandId must match /^cmd_[A-Za-z0-9_-]{1,80}$/',
      });
    }

    const auth = await requireMachineAuthAndScope(request, siteId, machineId, 'read');
    if (!auth.ok) return auth.response;

    const lookup = await lookupCommandStatus(getAdminDb(), siteId, machineId, commandId);
    if (!lookup) {
      return problem({
        type: ProblemType.NotFound,
        title: 'command not found',
        status: 404,
        detail: `command ${commandId} not found on machine ${machineId}`,
      });
    }

    const cmd = lookup.data;

    const responseBody: Record<string, unknown> = {
      ok: true,
      data: {
        commandId,
        status: lookup.status,
        ...(lookup.result !== undefined ? { result: lookup.result } : {}),
        ...(lookup.error !== undefined ? { error: lookup.error } : {}),
        createdAt: timestampToIso(cmd.timestamp ?? cmd.createdAt) ?? null,
        updatedAt: timestampToIso(cmd.updatedAt ?? cmd.completedAt) ?? null,
      },
    };

    return applyAuthDeprecations(NextResponse.json(responseBody), auth.scopeCheck);
  } catch (err) {
    return problemFromError(
      err,
      'sites/[siteId]/machines/[machineId]/commands/[commandId]:GET',
    );
  }
}
