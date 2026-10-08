/**
 * POST /api/sites/{siteId}/machines/{machineId}/commands — queue a remote
 * command. A thin authorized shim over `executeMachineCommand`; request shape,
 * idempotency, api-key scope, RFC 7807 errors and the 202 envelope are all
 * unchanged public contract.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  problem,
  problemFromError,
  problemPlanRequired,
  problemValidation,
  ProblemType,
} from '@/lib/apiErrors';
import { applyAuthDeprecations, readAndParseJsonBody } from '../../../../../_shared';
import { withIdempotency } from '@/lib/idempotency';
import { authorizedSiteHandler, type SiteRouteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  ALLOWED_COMMAND_TYPES,
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';

interface RouteParams {
  [key: string]: string | undefined;
  siteId: string;
  machineId: string;
}

interface CommandBody {
  type?: unknown;
  params?: unknown;
  timeout_seconds?: unknown;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

type NormalizedCommand =
  | { ok: true; type: string; payload: Record<string, unknown> }
  | { ok: false; response: NextResponse };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unsupportedCommandType(cmdType: string): NextResponse {
  return problem({
    type: ProblemType.ValidationFailed,
    title: 'unsupported command type',
    status: 400,
    detail:
      `command type '${cmdType}' is not accepted on this endpoint. ` +
      `allowed types: ${[...ALLOWED_COMMAND_TYPES].sort().join(', ')}`,
    code: 'unsupported_command_type',
  });
}

function copyOptionalString(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
): NextResponse | null {
  const value = input[key];
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    return problemValidation(`params.${key} must be a non-empty string when provided`, {
      [`body.params.${key}`]: ['must be a non-empty string'],
    });
  }
  output[key] = value;
  return null;
}

function copyOptionalPositiveInteger(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  min = 0,
): NextResponse | null {
  const value = input[key];
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) {
    return problemValidation(`params.${key} must be >= ${min} when provided`, {
      [`body.params.${key}`]: [`must be >= ${min}`],
    });
  }
  output[key] = Math.floor(n);
  return null;
}

function normalizeCommandBody(body: CommandBody): NormalizedCommand {
  if (typeof body.type !== 'string' || body.type.trim().length === 0) {
    return {
      ok: false,
      response: problemValidation('field `type` is required and must be a non-empty string', {
        'body.type': ['required non-empty string'],
      }),
    };
  }

  const cmdType = body.type.trim();
  if (!ALLOWED_COMMAND_TYPES.has(cmdType)) {
    return { ok: false, response: unsupportedCommandType(cmdType) };
  }

  const rawParams = body.params;
  if (rawParams !== undefined && rawParams !== null && !isPlainObject(rawParams)) {
    return {
      ok: false,
      response: problemValidation('field `params` must be an object when provided', {
        'body.params': ['must be an object'],
      }),
    };
  }
  const inputParams = (rawParams ?? {}) as Record<string, unknown>;

  let timeoutSeconds = DEFAULT_TIMEOUT_S;
  if (body.timeout_seconds !== undefined && body.timeout_seconds !== null) {
    const n = Number(body.timeout_seconds);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        response: problemValidation('timeout_seconds must be a positive number when provided', {
          'body.timeout_seconds': ['must be > 0'],
        }),
      };
    }
    timeoutSeconds = Math.min(Math.floor(n), MAX_TIMEOUT_S);
  }

  const payload: Record<string, unknown> = { timeout_seconds: timeoutSeconds };

  if (cmdType === 'reboot_machine' || cmdType === 'shutdown_machine') {
    const error = copyOptionalPositiveInteger(inputParams, payload, 'delay_seconds', 0);
    if (error) return { ok: false, response: error };
  } else if (cmdType === 'capture_screenshot') {
    const monitor = inputParams.monitor;
    if (monitor !== undefined) {
      if (typeof monitor === 'string') {
        if (monitor !== 'all' && monitor !== 'primary') {
          return {
            ok: false,
            response: problemValidation(
              'params.monitor must be "all", "primary", or a non-negative integer',
              { 'body.params.monitor': ['invalid value'] },
            ),
          };
        }
        payload.monitor = monitor;
      } else if (typeof monitor === 'number') {
        if (!Number.isFinite(monitor) || monitor < 0 || !Number.isInteger(monitor)) {
          return {
            ok: false,
            response: problemValidation(
              'params.monitor must be a non-negative integer when numeric',
              { 'body.params.monitor': ['invalid value'] },
            ),
          };
        }
        payload.monitor = monitor;
      } else {
        return {
          ok: false,
          response: problemValidation(
            'params.monitor must be "all", "primary", or a non-negative integer',
            { 'body.params.monitor': ['invalid value'] },
          ),
        };
      }
    }
  } else if (cmdType === 'dismiss_reboot_pending') {
    const error = copyOptionalString(inputParams, payload, 'process_name');
    if (error) return { ok: false, response: error };
  } else if (cmdType === 'start_live_view') {
    for (const key of ['interval', 'duration']) {
      const error = copyOptionalPositiveInteger(inputParams, payload, key, 1);
      if (error) return { ok: false, response: error };
    }
  } else if (
    cmdType === 'restart_process' ||
    cmdType === 'start_process' ||
    cmdType === 'stop_process' ||
    cmdType === 'kill_process'
  ) {
    for (const key of ['process_name', 'process_id']) {
      const error = copyOptionalString(inputParams, payload, key);
      if (error) return { ok: false, response: error };
    }
    if (payload.process_name === undefined && payload.process_id === undefined) {
      return {
        ok: false,
        response: problemValidation(
          'params.process_name or params.process_id is required for process commands',
          {
            'body.params.process_name': ['required when process_id is omitted'],
            'body.params.process_id': ['required when process_name is omitted'],
          },
        ),
      };
    }
  } else if (cmdType === 'set_launch_mode') {
    const processNameError = copyOptionalString(inputParams, payload, 'process_name');
    if (processNameError) return { ok: false, response: processNameError };
    if (payload.process_name === undefined) {
      return {
        ok: false,
        response: problemValidation('params.process_name is required for set_launch_mode', {
          'body.params.process_name': ['required'],
        }),
      };
    }
    const modeError = copyOptionalString(inputParams, payload, 'mode');
    if (modeError) return { ok: false, response: modeError };
    if (payload.mode === undefined) {
      return {
        ok: false,
        response: problemValidation('params.mode is required for set_launch_mode', {
          'body.params.mode': ['required'],
        }),
      };
    }
    if (inputParams.schedules !== undefined) {
      if (!Array.isArray(inputParams.schedules)) {
        return {
          ok: false,
          response: problemValidation('params.schedules must be an array when provided', {
            'body.params.schedules': ['must be an array'],
          }),
        };
      }
      payload.schedules = inputParams.schedules;
    }
    const presetError = copyOptionalString(inputParams, payload, 'schedulePresetId');
    if (presetError) return { ok: false, response: presetError };
  } else if (cmdType === 'apply_display_topology') {
    if (!isPlainObject(inputParams.layout)) {
      return {
        ok: false,
        response: problemValidation('params.layout is required and must be an object', {
          'body.params.layout': ['required object'],
        }),
      };
    }
    payload.layout = inputParams.layout;
    const error = copyOptionalString(inputParams, payload, 'applyId');
    if (error) return { ok: false, response: error };
    if (payload.applyId === undefined) {
      return {
        ok: false,
        response: problemValidation('params.applyId is required for apply_display_topology', {
          'body.params.applyId': ['required'],
        }),
      };
    }
  } else if (cmdType === 'ack_display_topology') {
    const error = copyOptionalString(inputParams, payload, 'applyId');
    if (error) return { ok: false, response: error };
    if (payload.applyId === undefined) {
      return {
        ok: false,
        response: problemValidation('params.applyId is required for ack_display_topology', {
          'body.params.applyId': ['required'],
        }),
      };
    }
  } else if (cmdType === 'mcp_tool_call') {
    const toolNameError = copyOptionalString(inputParams, payload, 'tool_name');
    if (toolNameError) return { ok: false, response: toolNameError };
    if (payload.tool_name === undefined) {
      return {
        ok: false,
        response: problemValidation('params.tool_name is required for mcp_tool_call', {
          'body.params.tool_name': ['required'],
        }),
      };
    }
    if (inputParams.tool_params !== undefined) {
      if (!isPlainObject(inputParams.tool_params)) {
        return {
          ok: false,
          response: problemValidation('params.tool_params must be an object when provided', {
            'body.params.tool_params': ['must be an object'],
          }),
        };
      }
      payload.tool_params = inputParams.tool_params;
    }
    const chatIdError = copyOptionalString(inputParams, payload, 'chat_id');
    if (chatIdError) return { ok: false, response: chatIdError };
  } else if (cmdType === 'cancel_mcp_tool') {
    const error = copyOptionalString(inputParams, payload, 'target_command_id');
    if (error) return { ok: false, response: error };
    if (payload.target_command_id === undefined) {
      return {
        ok: false,
        response: problemValidation('params.target_command_id is required for cancel_mcp_tool', {
          'body.params.target_command_id': ['required'],
        }),
      };
    }
  } else if (cmdType === 'update_owlette') {
    for (const key of ['installer_url', 'deployment_id', 'target_version', 'checksum_sha256']) {
      const error = copyOptionalString(inputParams, payload, key);
      if (error) return { ok: false, response: error };
    }
  }

  return { ok: true, type: cmdType, payload };
}

function commandErrorToProblem(err: ExecuteMachineCommandError): NextResponse {
  if (err.code === 'unsupported_command_type') {
    return unsupportedCommandType(err.detail.match(/'([^']+)'/)?.[1] ?? 'unknown');
  }
  if (err.entitlement) {
    return problemPlanRequired(err.detail, err.entitlement);
  }
  if (err.code === 'machine_offline') {
    return problem({
      type: ProblemType.Conflict,
      title: 'machine offline',
      status: 409,
      detail: err.detail,
      code: 'machine_offline',
    });
  }
  if (err.status === 404) {
    return problem({
      type: ProblemType.NotFound,
      title: 'machine not found',
      status: 404,
      detail: err.detail,
    });
  }
  return problem({
    type: ProblemType.ValidationFailed,
    title: 'validation failed',
    status: err.status,
    detail: err.detail,
    code: err.code,
  });
}

/**
 * Commands that observe a machine's screen without mutating it, so they sit
 * behind the read-class MACHINE_VIEW (which members hold on their sites)
 * instead of MACHINE_EXEC_COMMAND. Everything else stays admin/superadmin.
 */
const VIEW_COMMAND_TYPES: ReadonlySet<string> = new Set<string>([
  'capture_screenshot',
  'start_live_view',
  'stop_live_view',
]);

const coreHandler: SiteRouteHandler<RouteParams> = async (request, ctx, { params }) => {
  try {
    const { machineId } = await params;
    const siteId = ctx.siteId;

    const parsed = await readAndParseJsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = (parsed.body ?? {}) as CommandBody;

    return withIdempotency(
      request,
      {
        userId: ctx.actor.userId,
        environment: ctx.auth.keyContext?.environment ?? 'unknown',
      },
      parsed.raw,
      async () => {
        const normalized = normalizeCommandBody(body);
        if (!normalized.ok) return normalized.response;

        try {
          const result = await executeMachineCommand(
            {
              siteId,
              machineId,
              actor: ctx.actor,
              auditActor: ctx.auth.keyContext
                ? `apiKey:${ctx.auth.keyContext.keyId}`
                : `user:${ctx.actor.userId}`,
              correlationId: ctx.correlationId,
            },
            { type: normalized.type, payload: normalized.payload },
          );

          return applyAuthDeprecations(
            NextResponse.json(
              {
                ok: true,
                data: {
                  commandId: result.commandId,
                  status: 'pending',
                },
              },
              { status: 202 },
            ),
            ctx.scopeCheck,
          );
        } catch (err) {
          if (err instanceof ExecuteMachineCommandError) {
            return commandErrorToProblem(err);
          }
          throw err;
        }
      },
      { requireKey: true },
    );
  } catch (err) {
    return problemFromError(err, 'sites/[siteId]/machines/[machineId]/commands:POST');
  }
};

const sharedHandlerOptions = {
  siteIdParam: 'path' as const,
  targetKind: 'machine' as const,
  targetIdParam: 'machineId',
  apiKeyScope: {
    resource: 'machine' as const,
    idParam: 'machineId',
    permission: 'write' as const,
  },
};

// Mutating commands (reboot, process control, display topology).
const execHandler = authorizedSiteHandler<RouteParams>({
  capability: Capability.MACHINE_EXEC_COMMAND,
  ...sharedHandlerOptions,
})(coreHandler);

// MACHINE_VIEW only, so read-only members can use these. The api-key scope
// stays machine:write — only the user-role bar is lowered.
const viewHandler = authorizedSiteHandler<RouteParams>({
  capability: Capability.MACHINE_VIEW,
  ...sharedHandlerOptions,
})(coreHandler);

export async function POST(
  request: NextRequest,
  routeContext: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  // Peek on a CLONE so the chosen handler still gets an unconsumed body.
  // Anything not a view command — including unparseable or unknown — routes to
  // the stricter handler, which also emits the right 400.
  let cmdType = '';
  try {
    const peek = (await request.clone().json()) as { type?: unknown };
    if (typeof peek?.type === 'string') cmdType = peek.type.trim();
  } catch {
    // execHandler's coreHandler emits the proper validation error.
  }
  const handler = VIEW_COMMAND_TYPES.has(cmdType) ? viewHandler : execHandler;
  return handler(request, routeContext);
}
