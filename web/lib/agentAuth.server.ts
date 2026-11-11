/**
 * who an agent-facing route is talking to, from the bearer's own claims.
 *
 * an agent ID token carries `role: 'agent'` with string `site_id` and
 * `machine_id` claims. anything else (a user's ID token, a session cookie, an
 * api key) resolves to null here, so a route that asks for an agent principal
 * never mistakes a person for a machine. nothing in here logs a token or a
 * claim set.
 */

import type { NextRequest } from 'next/server';
import { getAdminAuth } from '@/lib/firebase-admin';

export interface AgentPrincipal {
  siteId: string;
  machineId: string;
  userId: string;
}

/** The bearer's claims, but only for a verified `role=agent` id token. */
export async function agentClaims(req: NextRequest): Promise<AgentPrincipal | null> {
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
