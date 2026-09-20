/**
 * Shared pieces of the three agent-facing swoop routes.
 *
 * Authentication is `requireMachineAuthAndScope` because it binds BOTH
 * `site_id` and `machine_id`; the `…OrSite…` helpers in `app/api/_shared.ts`
 * check `site_id` only, so machine A's token would reach machine B's bundle
 * through them. It is necessary but not sufficient: non-key auth skips the
 * scope check there, so any site member holding a session cookie passes it.
 * Every route therefore also resolves an agent principal from the bearer's own
 * claims and refuses everything else — that is what keeps a session or api-key
 * caller away from a bundle.
 *
 * Nothing in here logs a token, a key or a claim set.
 */

import type { NextRequest, NextResponse } from 'next/server';
import { requireMachineAuthAndScope } from '@/app/api/_shared';
import { problemNotFound } from '@/lib/apiErrors';
import type { ApiKeyPermission } from '@/lib/apiKeyTypes';
import { getAdminAuth } from '@/lib/firebase-admin';

/** PROTOCOL.md §8's `site` / `machine` / `sid` shape. */
export const SWOOP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface SwoopAgentPrincipal {
  siteId: string;
  machineId: string;
  userId: string;
}

export type SwoopAgentAuth =
  | { ok: true; agent: SwoopAgentPrincipal }
  | { ok: false; response: NextResponse };

/** A 404 rather than a 401/403: a caller that is not this machine's agent
 * learns nothing about whether the machine exists. */
function notFound(): { ok: false; response: NextResponse } {
  return { ok: false, response: problemNotFound('site not found or no access') };
}

/** The bearer's claims, but only for a verified `role=agent` id token. */
async function agentClaims(req: NextRequest): Promise<SwoopAgentPrincipal | null> {
  const bearer = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  // `owk_` is an api key — a user credential, never an agent principal.
  if (!bearer || bearer[1].startsWith('owk_')) return null;
  try {
    const decoded = await getAdminAuth().verifyIdToken(bearer[1]);
    if (decoded.role !== 'agent') return null;
    if (typeof decoded.site_id !== 'string' || typeof decoded.machine_id !== 'string') return null;
    return { siteId: decoded.site_id, machineId: decoded.machine_id, userId: decoded.uid };
  } catch {
    return null;
  }
}

/**
 * `expected` is the site/machine the request body names. Omit it and the ids
 * come from the token's own claims — the doorbell posts an empty body, because
 * the room it parks on is addressed from those claims and nothing else.
 */
export async function requireSwoopAgent(
  req: NextRequest,
  permission: ApiKeyPermission,
  expected?: { siteId: string; machineId: string },
): Promise<SwoopAgentAuth> {
  const claims = await agentClaims(req);
  if (!claims) return notFound();

  const siteId = expected?.siteId ?? claims.siteId;
  const machineId = expected?.machineId ?? claims.machineId;

  const scoped = await requireMachineAuthAndScope(req, siteId, machineId, permission);
  if (!scoped.ok) return { ok: false, response: scoped.response };

  // The agent short-circuit inside that helper compares the same two claims,
  // but only on the branch it takes. Asserting here means no later change to
  // it can let machine A act on machine B through these routes.
  if (claims.siteId !== siteId || claims.machineId !== machineId) return notFound();

  return { ok: true, agent: { siteId, machineId, userId: claims.userId } };
}

/**
 * `wss://…/v1/room/{site}/{machine}` — the signaling Worker's only
 * url-addressed route. `SWOOP_SIGNAL_URL` is an http(s) origin (it is also
 * where `lib/swoop/signal.server.ts` POSTs `/v1/ring`), so the scheme is
 * upgraded here; null means the origin is unset or unusable.
 */
export function swoopRoomUrl(siteId: string, machineId: string): string | null {
  const base = process.env.SWOOP_SIGNAL_URL;
  if (!base) return null;
  const origin = base
    .trim()
    .replace(/\/+$/, '')
    .replace(/^https:/i, 'wss:')
    .replace(/^http:/i, 'ws:');
  if (!/^wss?:\/\/[^/]+$/i.test(origin)) return null;
  return `${origin}/v1/room/${encodeURIComponent(siteId)}/${encodeURIComponent(machineId)}`;
}

/** These responses are per-request secrets; no cache may hold one. */
export const NO_STORE = { 'cache-control': 'no-store' } as const;
