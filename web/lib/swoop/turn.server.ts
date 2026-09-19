/**
 * Cloudflare Realtime TURN credentials for a swoop session.
 *
 * P2P first; TURN is the fallback (plan.md D13). Cloudflare bills only
 * server->client egress, so `customIdentifier` is the site id and the metering
 * in Wave 8 reads it back per site.
 *
 * Credentials are short-lived and revoked on every clean end (session DELETE,
 * kill, membership revocation). They are never stored in `swoop_sessions`.
 */

import logger from '@/lib/logger';

const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/** Cloudflare's documented ceiling: "up to 48 hours in the future". */
export const TURN_MAX_TTL_SECONDS = 48 * 60 * 60;

/** A session's cap is 12 h (plan.md D10), so this is the default we ask for. */
export const TURN_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

const TURN_TIMEOUT_MS = 5000;

export interface SwoopIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export type TurnFailureReason =
  | 'not_configured'
  | 'unreachable'
  | 'rejected'
  | 'malformed_response';

export type TurnMintResult =
  | { ok: true; iceServers: SwoopIceServer[]; username: string; expiresAt: number }
  | { ok: false; reason: TurnFailureReason };

export type TurnRevokeResult = { ok: true } | { ok: false; reason: TurnFailureReason };

interface TurnCredentials {
  keyId: string;
  apiToken: string;
}

function credentials(): TurnCredentials | null {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN;
  if (!keyId || !apiToken) return null;
  return { keyId, apiToken };
}

function parseIceServers(body: unknown): SwoopIceServer[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const list = (body as { iceServers?: unknown }).iceServers;
  if (!Array.isArray(list)) return null;

  const servers: SwoopIceServer[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const urlList = typeof urls === 'string' ? [urls] : urls;
    if (!Array.isArray(urlList) || urlList.some((u) => typeof u !== 'string')) return null;
    servers.push({
      urls: urlList as string[],
      ...(typeof username === 'string' ? { username } : {}),
      ...(typeof credential === 'string' ? { credential } : {}),
    });
  }
  return servers;
}

/**
 * Mint an ICE server list for one session.
 *
 * `customIdentifier` is documented only on `/credentials/generate`; whether
 * `/credentials/generate-ice-servers` honours it is UNVERIFIED (spike 6.8
 * measures it). It is sent anyway because it is inert if ignored — if the
 * spike shows it dropped, call `/credentials/generate` instead and build the
 * `iceServers` array here from its `username`/`credential` pair.
 */
export async function mintTurnCredentials(args: {
  siteId: string;
  ttlSeconds?: number;
}): Promise<TurnMintResult> {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'not_configured' };

  const ttl = Math.min(
    Math.max(1, Math.floor(args.ttlSeconds ?? TURN_DEFAULT_TTL_SECONDS)),
    TURN_MAX_TTL_SECONDS,
  );

  let payload: unknown;
  try {
    const response = await fetch(
      `${TURN_API_BASE}/${encodeURIComponent(creds.keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.apiToken}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        body: JSON.stringify({ ttl, customIdentifier: args.siteId }),
      },
    );
    if (!response.ok) {
      logger.warn('[swoop/turn] credential mint rejected', {
        context: 'swoop/turn',
        data: { status: response.status, siteId: args.siteId },
      });
      return { ok: false, reason: 'rejected' };
    }
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'unreachable' };
  }

  const iceServers = parseIceServers(payload);
  const username = iceServers?.find((s) => s.username)?.username;
  if (!iceServers || !username) return { ok: false, reason: 'malformed_response' };

  return { ok: true, iceServers, username, expiresAt: Date.now() + ttl * 1000 };
}

/**
 * Revoke one credential by its username. Called on session DELETE, on kill and
 * when a member's access is revoked mid-session — the TTL alone would leave a
 * relay allocation billable for hours after the session ended.
 */
export async function revokeTurnCredentials(username: string): Promise<TurnRevokeResult> {
  const creds = credentials();
  if (!creds) return { ok: false, reason: 'not_configured' };
  if (!username) return { ok: false, reason: 'rejected' };

  try {
    const response = await fetch(
      `${TURN_API_BASE}/${encodeURIComponent(creds.keyId)}/credentials/${encodeURIComponent(username)}/revoke`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.apiToken}` },
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      },
    );
    // 204 No Content on success. A 404 means it already lapsed, which is the
    // outcome the caller wanted either way.
    if (!response.ok && response.status !== 404) return { ok: false, reason: 'rejected' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}
