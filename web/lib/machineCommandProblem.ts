/**
 * what an `ExecuteMachineCommandError` looks like to an api caller, shared by the
 * routes that queue commands.
 */
import type { NextResponse } from 'next/server';
import { problem, problemPlanRequired, ProblemType } from '@/lib/apiErrors';
import {
  ALLOWED_COMMAND_TYPES,
  type ExecuteMachineCommandError,
} from '@/lib/actions/executeMachineCommand.server';

export function unsupportedCommandType(cmdType: string): NextResponse {
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

export function commandErrorToProblem(err: ExecuteMachineCommandError): NextResponse {
  if (err.code === 'unsupported_command_type') {
    return unsupportedCommandType(err.detail.match(/'([^']+)'/)?.[1] ?? 'unknown');
  }
  if (err.entitlement) {
    return problemPlanRequired(err.detail, err.entitlement);
  }
  if (err.code === 'machine_offline' || err.code === 'held_restart_unsupported') {
    return problem({
      type: ProblemType.Conflict,
      title: err.code === 'machine_offline' ? 'machine offline' : 'held restart unsupported',
      status: 409,
      detail: err.detail,
      code: err.code,
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
