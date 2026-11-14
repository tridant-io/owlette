/**
 * Shared helpers for the process control verbs (kill/restart/start/stop): each
 * validates the process, then queues a command via `executeMachineCommand`.
 *
 * `schedule` is deliberately NOT here — it goes through `withProcessLock` with
 * no command queue, in its own route file.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApiAuthError } from '@/lib/apiAuth.server';
import { problemPlanRequired } from '@/lib/apiErrors';
import { ProcessConfigError, readProcessList } from '@/lib/processConfig.server';
import { withIdempotency } from '@/lib/idempotency';
import { emitMutation } from '@/lib/auditLogClient';
import { authorizedSiteHandler } from '@/lib/authorizedHandler.server';
import { Capability } from '@/lib/capabilities';
import {
  executeMachineCommand,
  ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';
import logger from '@/lib/logger';

export type ControlVerb = 'kill' | 'restart' | 'start' | 'stop';

interface RouteParams {
  [key: string]: string | undefined;
  siteId: string;
  machineId: string;
  processId: string;
}

const VERB_TO_COMMAND: Record<ControlVerb, string> = {
  kill: 'kill_process',
  restart: 'restart_process',
  start: 'start_process',
  stop: 'stop_process',
};

/** Validate the process, queue its command, emit audit, return the commandId. */
export function handleControlVerb(
  verb: ControlVerb,
  request: NextRequest,
  context: { params: Promise<RouteParams> },
): Promise<NextResponse> {
  return CONTROL_HANDLERS[verb](request, context);
}

const CONTROL_HANDLERS: Record<
  ControlVerb,
  (request: NextRequest, context: { params: Promise<RouteParams> }) => Promise<NextResponse>
> = {
  kill: createControlHandler('kill'),
  restart: createControlHandler('restart'),
  start: createControlHandler('start'),
  stop: createControlHandler('stop'),
};

function createControlHandler(verb: ControlVerb) {
  return authorizedSiteHandler<RouteParams>({
    capability: Capability.MACHINE_EXEC_COMMAND,
    siteIdParam: 'path',
    targetKind: 'process',
    targetIdParam: 'processId',
    apiKeyScope: { resource: 'machine', idParam: 'machineId', permission: 'write' },
  })(async (request, ctx, routeContext) => {
    try {
      const { machineId, processId } = await routeContext.params;
      const siteId = ctx.siteId;
      const rawBody = await request.text();

      return withIdempotency(
        request,
        {
          userId: ctx.actor.userId,
          environment: ctx.auth.keyContext?.environment ?? 'unknown',
        },
        rawBody,
        async () => {
          // Never queue a command for a ghost process id.
          const processes = await readProcessList(siteId, machineId);
          if (!processes) {
            return problem(404, 'process_not_found', 'No machine config found.');
          }
          const proc = processes.find((p) => p.processId === processId);
          if (!proc) {
            return problem(404, 'process_not_found', `Process ${processId} not found.`);
          }

          const commandType = VERB_TO_COMMAND[verb];
          let commandId: string;
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
              {
                type: commandType,
                payload: {
                  process_id: processId,
                  processId,
                  process_name: proc.name,
                },
              },
            );
            commandId = result.commandId;
          } catch (error) {
            if (error instanceof ExecuteMachineCommandError) {
              return commandErrorResponse(error);
            }
            throw error;
          }

          emitMutation({
            kind: 'process_mutated',
            siteId,
            actor: ctx.auth.keyContext
              ? `apiKey:${ctx.auth.keyContext.keyId}`
              : `user:${ctx.actor.userId}`,
            targetId: processId,
            attributes: {
              verb,
              endpoint: `processes/${verb}`,
              method: 'POST',
              machineId,
              commandId,
              commandType,
            },
          });

          logger.info(`Process ${verb}: ${proc.name} on ${machineId} (cmd=${commandId})`, {
            context: 'sites/machines/processes',
          });

          return NextResponse.json(
            { ok: true, data: { commandId, status: 'pending' } },
            { status: 202 },
          );
        },
        { requireKey: true },
      );
    } catch (error: unknown) {
      return errorResponse(error, `sites/machines/processes/${verb}`);
    }
  });
}

export function problem(status: number, code: string, detail: string): NextResponse {
  return NextResponse.json(
    { type: 'about:blank', title: code, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json' } }
  );
}

export function errorResponse(error: unknown, ctx: string): NextResponse {
  if (error instanceof ApiAuthError) {
    return problem(error.status, error.status === 403 ? 'scope_insufficient' : 'unauthorized', error.message);
  }
  if (error instanceof ProcessConfigError) {
    return problem(error.status, error.code || 'process_config_error', error.message);
  }
  console.error(`${ctx}:`, error);
  return problem(500, 'internal_error', error instanceof Error ? error.message : 'Internal server error');
}

function commandErrorResponse(error: ExecuteMachineCommandError): NextResponse {
  if (error.entitlement) {
    return problemPlanRequired(error.detail, error.entitlement);
  }
  if (error.code === 'machine_offline') {
    return problem(409, error.code, error.detail);
  }
  if (error.status === 404) {
    return problem(404, 'machine_not_found', error.detail);
  }
  return problem(error.status, error.code, error.detail);
}
