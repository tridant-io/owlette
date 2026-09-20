/**
 * Refusal plumbing shared by the three user-facing swoop session routes
 * (`sessions`, `sessions/{sid}`, `sessions/{sid}/lease`).
 *
 * Every decision itself lives in `lib/swoop/policy.server.ts` — this only turns
 * one into an RFC 7807 response and mints the opaque ids. Nothing here reads or
 * writes a session document, and nothing here ever touches a token or a key.
 */

import type { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { problem, ProblemType } from '@/lib/apiErrors';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';
import {
  loadSwoopSettings,
  type SwoopAccessInput,
  type SwoopDecision,
  type SwoopIntent,
} from '@/lib/swoop/policy.server';

export interface SwoopRouteParams {
  [key: string]: string | undefined;
  siteId: string;
  machineId: string;
  sessionId?: string;
}

/**
 * The sid charset. `requestSwoopSession` admits 128 characters, the JWT claim
 * pattern only 64, so a sid must satisfy the narrower of the two or it can be
 * queued but never minted into a viewer token.
 */
const SID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSid(value: unknown): value is string {
  return typeof value === 'string' && SID_PATTERN.test(value);
}

/**
 * 32 hex characters — 128 bits from `randomUUID` with the hyphens removed.
 * Hyphens are legal in both patterns, but a sid reaches a room name, a log line
 * and a durable-object key, so an id with no separator in it cannot be
 * mis-split anywhere downstream.
 */
export function mintSwoopId(): string {
  return randomUUID().replace(/-/g, '');
}

type SwoopDenial = Extract<SwoopDecision, { ok: false }>;

/** A policy refusal as the caller sees it. `code` is the branchable half. */
export function decisionProblem(decision: SwoopDenial): NextResponse {
  const unauthorized = decision.status === 401;
  return problem({
    type: unauthorized ? ProblemType.Unauthorized : ProblemType.Forbidden,
    title: unauthorized ? 'step-up required' : 'forbidden',
    status: decision.status,
    detail: decision.error,
    code: decision.code,
  });
}

/** swoop cannot run without the signaling worker, so a missing url is a 503. */
export function swoopNotConfigured(): NextResponse {
  return problem({
    type: ProblemType.ServiceUnavailable,
    title: 'service unavailable',
    status: 503,
    detail: 'swoop signaling is not configured for this deployment.',
    code: 'swoop_not_configured',
  });
}

/** The room the viewer and the host both join. Never carries a token or a key. */
export function viewerSignalUrl(siteId: string, machineId: string): string | null {
  const base = process.env.SWOOP_SIGNAL_URL;
  if (!base) return null;
  const origin = base.replace(/\/+$/, '').replace(/^http/, 'ws');
  return `${origin}/v1/room/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}`;
}

/** Everything `evaluateSwoopAccess` / `evaluateLeaseRenewal` need but the window state. */
export type SwoopGate = Omit<SwoopAccessInput, 'stepUpOpen'>;

export async function swoopGate(args: {
  ctx: SiteHandlerContext;
  machineId: string;
  intent: SwoopIntent;
}): Promise<SwoopGate> {
  return {
    actor: args.ctx.actor,
    siteId: args.ctx.siteId,
    machineId: args.machineId,
    intent: args.intent,
    viaApiKey: args.ctx.auth.keyContext !== null,
    settings: await loadSwoopSettings(args.ctx.siteId),
  };
}

/**
 * The api-key refusal, ahead of every read. `evaluateSwoopAccess` refuses a key
 * too — this only moves the answer in front of the Firestore work, because no
 * later check can ever admit one.
 */
export function apiKeyRefusal(ctx: SiteHandlerContext): NextResponse | null {
  if (ctx.auth.keyContext === null) return null;
  return decisionProblem({
    ok: false,
    status: 403,
    code: 'api_key_not_permitted',
    error: 'swoop sessions cannot be started with an api key.',
  });
}
