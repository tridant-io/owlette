/**
 * POST /api/agent/swoop/bundle — the session bundle, PROTOCOL.md §7.
 *
 * The response body IS the bundle document, not a `{bundle: …}` envelope: the
 * agent (`agent/src/swoop_spawn.py:fetch_bundle`) hands the raw body to the
 * streamer as line 1 of stdin, and `Bundle::parse` deserialises exactly the
 * shape §7 documents. Wrapping it would mean unwrapping it on the agent.
 *
 * Nothing here is logged — not the host token, not `sessionKey`, not the TURN
 * credential, not partially, not at debug. `apiError` reports the route name
 * only, and the TURN warning below carries a reason code and a site id.
 */

import { createPublicKey } from 'crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/apiErrorResponse';
import { problemValidation } from '@/lib/apiErrors';
import logger from '@/lib/logger';
import { sessionKeyForBundle } from '@/lib/swoop/keys.server';
import {
  SWOOP_LEASE_SECONDS,
  SWOOP_SESSION_CAP_SECONDS,
  loadSwoopSettings,
} from '@/lib/swoop/policy.server';
import { SWOOP_PROTOCOL_VERSION } from '@/lib/swoop/protocol';
import { getSwoopSession } from '@/lib/swoop/sessionStore.server';
import { mintHostToken, swoopJwtPublicKeys, type SwoopJwtKeyEntry } from '@/lib/swoop/tokens.server';
import { mintTurnCredentials, type SwoopIceServer } from '@/lib/swoop/turn.server';
import { SWOOP_MIN_AGENT_VERSION, compareVersions, isValidVersion } from '@/lib/versionUtils';
import { withRateLimit } from '@/lib/withRateLimit';
import { NO_STORE, SWOOP_ID_PATTERN, requireSwoopAgent, swoopRoomUrl } from '../_shared';

/**
 * Concurrent viewers of one machine. A bundle field rather than a site setting
 * because the streamer is what enforces it; it becomes a setting the day an
 * operator asks for a different number.
 */
const SWOOP_MAX_VIEWERS = 4;

/** DER wrapper so a raw 32-byte ed25519 key becomes a KeyObject without PEM. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Raw 32-byte base64url, the shape `jwtKeys[].key` carries. */
function rawPublicKey(value: string): string | null {
  try {
    const key = value.includes('BEGIN')
      ? createPublicKey(value.replace(/\\n/g, '\n'))
      : createPublicKey({
          key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(value.trim(), 'base64')]),
          format: 'der',
          type: 'spki',
        });
    return key
      .export({ format: 'der', type: 'spki' })
      .subarray(SPKI_ED25519_PREFIX.length)
      .toString('base64url');
  } catch {
    return null;
  }
}

/**
 * Current key plus the previous one — PROTOCOL.md §11 rotates with a two-key
 * overlap, so a token signed before the flip still verifies. `swoopJwtPublicKeys()`
 * returns the current pair only; the previous slot is read from the environment
 * here (`SWOOP_JWT_KID_PREVIOUS` / `SWOOP_JWT_PUBLIC_KEY_PREVIOUS`, registered in
 * `scripts/env-manifest.json` as config on every target and set to the empty
 * string outside a rotation window), and an empty value simply means one
 * active key.
 */
function bundleJwtKeys(): SwoopJwtKeyEntry[] {
  const keys = swoopJwtPublicKeys();
  const value = process.env.SWOOP_JWT_PUBLIC_KEY_PREVIOUS;
  const kid = process.env.SWOOP_JWT_KID_PREVIOUS;
  if (!value || !kid || kid === keys[0].kid) return keys;

  const key = rawPublicKey(value);
  if (!key) {
    // Loud, because the silent alternative is every token minted before the
    // rotation failing verification with no explanation.
    logger.warn('[swoop/bundle] previous jwt public key is unusable; overlap is off', {
      context: 'swoop/bundle',
    });
    return keys;
  }
  return [...keys, { kid, alg: 'EdDSA', key }];
}

interface BundleRequest {
  siteId: string;
  machineId: string;
  sid: string;
  agentVersion: string;
}

function parseBody(body: unknown): BundleRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const { siteId, machineId, sid, agentVersion } = body as Record<string, unknown>;
  if (typeof siteId !== 'string' || typeof machineId !== 'string') return null;
  if (typeof sid !== 'string' || !SWOOP_ID_PATTERN.test(sid)) return null;
  if (typeof agentVersion !== 'string' || !isValidVersion(agentVersion)) return null;
  return { siteId, machineId, sid, agentVersion };
}

export const POST = withRateLimit(
  async (request: NextRequest): Promise<NextResponse> => {
    try {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return problemValidation('request body is not valid json');
      }
      const body = parseBody(raw);
      if (!body) {
        return problemValidation('siteId, machineId, sid and agentVersion are required');
      }

      const auth = await requireSwoopAgent(request, 'read', {
        siteId: body.siteId,
        machineId: body.machineId,
      });
      if (!auth.ok) return auth.response;
      const { siteId, machineId } = auth.agent;

      // null means unparseable, which `parseBody` already ruled out; treat it
      // as too old anyway rather than letting it through on a falsy compare.
      const versionOrder = compareVersions(body.agentVersion, SWOOP_MIN_AGENT_VERSION);
      if (versionOrder === null || versionOrder < 0) {
        return NextResponse.json(
          { error: 'this agent is too old to serve a swoop session.', code: 'agent_too_old' },
          { status: 403, headers: NO_STORE },
        );
      }

      const settings = await loadSwoopSettings(siteId);
      if (!settings.enabled) {
        return NextResponse.json(
          { error: 'swoop is not enabled for this site.', code: 'swoop_disabled' },
          { status: 403, headers: NO_STORE },
        );
      }
      if (settings.excludedMachineIds.includes(machineId)) {
        return NextResponse.json(
          { error: 'swoop is excluded on this machine.', code: 'machine_excluded' },
          { status: 403, headers: NO_STORE },
        );
      }

      // The session document lives under the machine it was minted for, so a
      // sid belonging to another machine is simply absent here. The explicit
      // comparison below is the second lock on the same door.
      const session = await getSwoopSession(siteId, machineId, body.sid);
      if (!session || session.machineId !== machineId || session.state === 'ended') {
        return NextResponse.json(
          { error: 'session not found.', code: 'session_not_found' },
          { status: 404, headers: NO_STORE },
        );
      }

      const signalUrl = swoopRoomUrl(siteId, machineId);
      if (!signalUrl) {
        return NextResponse.json(
          { error: 'signaling is not configured.', code: 'signal_not_configured' },
          { status: 503, headers: NO_STORE },
        );
      }

      // P2P first (plan.md D13). A TURN outage costs the relay fallback, never
      // the session, so an empty list beats a 500.
      let iceServers: SwoopIceServer[] = [];
      const turn = await mintTurnCredentials({ siteId });
      if (turn.ok) {
        iceServers = turn.iceServers;
      } else {
        logger.warn('[swoop/bundle] no turn credentials; relay fallback unavailable', {
          context: 'swoop/bundle',
          data: { siteId, reason: turn.reason },
        });
      }

      const nowMs = Date.now();
      const hostToken = mintHostToken({ site: siteId, machine: machineId, sid: body.sid });

      return NextResponse.json(
        {
          protocolVersion: SWOOP_PROTOCOL_VERSION,
          // The streamer refuses a bundle whose `agentVersion` differs from its
          // own compiled-in version, which is how a stale exe left behind by a
          // delay-until-reboot upgrade is caught. Echoing the version the
          // service reported is what makes that comparison meaningful.
          agentVersion: body.agentVersion,
          sid: body.sid,
          site: siteId,
          machine: machineId,
          // The only clock the streamer trusts (PROTOCOL.md §7).
          now: Math.floor(nowMs / 1000),
          streamerEpoch: nowMs * 1000,
          signalUrl,
          hostToken: hostToken.token,
          jwtKeys: bundleJwtKeys(),
          sessionKey: sessionKeyForBundle(body.sid),
          iceServers,
          enablement: {
            membersMayWatch: settings.membersMayWatch,
            maxViewers: SWOOP_MAX_VIEWERS,
            leaseSeconds: SWOOP_LEASE_SECONDS,
            sessionCapSeconds: SWOOP_SESSION_CAP_SECONDS,
          },
          indicator: settings.indicator,
          // The session floor, not a grant: a viewer's own `ctl` comes from its
          // jwt, and the api mints a control token only for a caller that
          // passed `evaluateSwoopAccess` with intent `control`.
          ctl: true,
        },
        { headers: NO_STORE },
      );
    } catch (error: unknown) {
      return apiError(error, 'agent/swoop/bundle');
    }
  },
  { strategy: 'api', identifier: 'ip' },
);
