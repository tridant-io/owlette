/**
 * POST /api/sites/{siteId}/machines/{machineId}/path-check — ask a machine whether
 * a path exists, or what a folder holds, for the process editor. queues the
 * read-only `check_path` command; the answer lands in `commands/completed`.
 *
 * it tells its caller what is on a machine's disk, so it holds the capability that
 * may edit that machine's process config and nothing wider, and it refuses api keys
 * outright: a key gains nothing here, and the type is not on the public command
 * allowlist either. see docs/adr/0014-*.
 */
import { NextResponse } from 'next/server';
import { problemForbidden, problemFromError, problemValidation } from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '../../../../../_shared';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import { commandErrorToProblem } from '@/lib/machineCommandProblem';
import { MAX_PATH_VALUE_CHARS, PATH_FIELDS, type PathCheckField } from '@/lib/pathCheck';

interface RouteParams {
  [key: string]: string | undefined;
  siteId: string;
  machineId: string;
}

const FIELDS: ReadonlySet<unknown> = new Set<PathCheckField>([...PATH_FIELDS, 'folder']);
const CONTROL_CHARACTERS = /[\u0000-\u001f]/;

export const POST = authorizedSiteHandler<RouteParams>({
  capability: Capability.MACHINE_CONFIG_WRITE,
  siteIdParam: 'path',
  targetKind: 'machine',
  targetIdParam: 'machineId',
})(async (request, ctx, { params }) => {
  try {
    if (ctx.auth.keyContext) {
      return problemForbidden('path checks are for the dashboard: api keys cannot use this route');
    }

    const { machineId } = await params;
    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const { field, value } = (parsed.body ?? {}) as { field?: unknown; value?: unknown };

    if (!FIELDS.has(field)) {
      return problemValidation('field must be exe_path, file_path, cwd or folder', {
        'body.field': ['must be exe_path, file_path, cwd or folder'],
      });
    }
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0 || trimmed.length > MAX_PATH_VALUE_CHARS || CONTROL_CHARACTERS.test(trimmed)) {
      return problemValidation(`value must be 1 to ${MAX_PATH_VALUE_CHARS} characters with no control characters`, {
        'body.value': ['invalid value'],
      });
    }

    try {
      const { commandId } = await executeMachineCommand(
        {
          siteId: ctx.siteId,
          machineId,
          actor: ctx.actor,
          auditActor: `user:${ctx.actor.userId}`,
          correlationId: ctx.correlationId,
        },
        {
          type: 'check_path',
          payload: { field, value: trimmed },
          auditAttributes: {
            endpoint: `/api/sites/${ctx.siteId}/machines/${machineId}/path-check`,
            field,
            value: trimmed,
          },
        },
        { dashboardOnly: true },
      );
      return applyAuthDeprecations(
        NextResponse.json({ ok: true, data: { commandId, status: 'pending' } }, { status: 202 }),
        ctx.scopeCheck,
      );
    } catch (err) {
      if (err instanceof ExecuteMachineCommandError) return commandErrorToProblem(err);
      throw err;
    }
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/path-check:POST');
  }
});
