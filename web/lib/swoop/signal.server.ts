/**
 * The server's only client for the signaling Worker's control routes.
 *
 * Both routes are NOTIFICATIONS, never carriers: they take `{site, machine, sid}`
 * and nothing else (PROTOCOL.md §11, spike 0.4 §4). The sid is opaque; the
 * bundle, the tokens, the keys and the TURN credentials reach the agent over
 * its own authenticated channel and never through here.
 *
 * A failure is typed, never thrown: the caller falls back to the polled
 * Firestore command (2-5 s pickup) rather than turning a relay hiccup into a
 * 500 on a session the user can still get.
 *
 * `SWOOP_SIGNAL_RING_SECRET` is never logged, not even partially.
 */

import logger from '@/lib/logger';

const SIGNAL_TIMEOUT_MS = 3000;

export type SwoopSignalFailure =
  | 'not_configured'
  | 'unauthorized'
  | 'no_doorbell'
  | 'ring_capped'
  | 'unreachable'
  | 'rejected';

export type SwoopSignalResult =
  | { ok: true }
  | { ok: false; reason: SwoopSignalFailure; retryAfterMs?: number };

interface SignalConfig {
  baseUrl: string;
  secret: string;
}

function config(): SignalConfig | null {
  const baseUrl = process.env.SWOOP_SIGNAL_URL;
  const secret = process.env.SWOOP_SIGNAL_RING_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), secret };
}

async function post(
  path: '/v1/ring' | '/v1/kill',
  body: { site: string; machine: string; sid?: string },
): Promise<SwoopSignalResult> {
  const cfg = config();
  if (!cfg) return { ok: false, reason: 'not_configured' };

  let response: Response;
  try {
    response = await fetch(`${cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Constant-time compared on the Worker side.
        'x-swoop-ring-secret': cfg.secret,
      },
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  if (response.ok) return { ok: true };

  if (response.status === 401 || response.status === 403) {
    // Almost always a mirror mismatch: the failover origin holding a different
    // SWOOP_SIGNAL_RING_SECRET than the Worker. Worth a warning every time.
    logger.warn('[swoop/signal] control route refused our secret', {
      context: 'swoop/signal',
      data: { path, status: response.status, machine: body.machine },
    });
    return { ok: false, reason: 'unauthorized' };
  }
  if (response.status === 404 || response.status === 409) {
    return { ok: false, reason: 'no_doorbell' };
  }
  if (response.status === 429) {
    const retryAfterMs = await parseRetryAfterMs(response);
    return { ok: false, reason: 'ring_capped', ...(retryAfterMs ? { retryAfterMs } : {}) };
  }
  return { ok: false, reason: 'rejected' };
}

async function parseRetryAfterMs(response: Response): Promise<number | undefined> {
  try {
    const body: unknown = await response.json();
    const value = (body as { retryAfterMs?: unknown })?.retryAfterMs;
    return typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wake an idle machine's doorbell socket so it fetches its bundle now instead
 * of at the next command poll.
 *
 * Only ring a machine that is already connected: whoever touches a room name
 * first fixes its Durable Object home location forever, so ringing a machine
 * that has never dialled homes its room next to the API's colo permanently
 * (spike 0.4 §7).
 */
export async function ringDoorbell(args: {
  siteId: string;
  machineId: string;
  sid: string;
}): Promise<SwoopSignalResult> {
  return post('/v1/ring', { site: args.siteId, machine: args.machineId, sid: args.sid });
}

/**
 * The authoritative kill (<= 2 s): the Worker broadcasts `kill` and the
 * streamer exits. `sid` is optional — absent means "kill whatever is running",
 * which is what a revocation wants when it does not know the live session.
 */
export async function killSession(args: {
  siteId: string;
  machineId: string;
  sid?: string;
}): Promise<SwoopSignalResult> {
  return post('/v1/kill', {
    site: args.siteId,
    machine: args.machineId,
    ...(args.sid ? { sid: args.sid } : {}),
  });
}
