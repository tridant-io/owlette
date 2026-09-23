// swoop signaling Worker — spike 0.4.
//
// Routes and message names are the plan's names registry. The Durable Object name
// is derived from the *token's* site/machine claims and never from the path, so a
// client cannot address someone else's room by asking for it (review-2-security.md,
// "sections that held up").

import { keysetSummary, verifySignalToken } from './jwt.js';
import { SignalRoom } from './room.js';

export { SignalRoom };

const SUBPROTOCOL = 'owlette.swoop.v1';
const TOKEN_SUBPROTOCOL_PREFIX = 'jwt.';

function json(body, status = 200) {
  return Response.json(body, { status });
}

function errorResponse(code, status) {
  return json({ type: 'error', code }, status);
}

// Browsers cannot set headers on a WebSocket handshake, so a viewer carries its
// token as a second subprotocol. Only the plain subprotocol is echoed back — the
// token never appears in a response header or a URL, and so never in an access log.
function extractToken(request) {
  const authorization = request.headers.get('Authorization');
  if (authorization && authorization.startsWith('Bearer ')) {
    return { token: authorization.slice(7), subprotocol: null };
  }
  const offered = request.headers.get('Sec-WebSocket-Protocol');
  if (offered) {
    const parts = offered.split(',').map((part) => part.trim());
    const carrier = parts.find((part) => part.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
    if (carrier && parts.includes(SUBPROTOCOL)) {
      return { token: carrier.slice(TOKEN_SUBPROTOCOL_PREFIX.length), subprotocol: SUBPROTOCOL };
    }
  }
  return { token: null, subprotocol: null };
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function roomStub(env, site, machine) {
  return env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(`${site}:${machine}`));
}

async function handleRoom(request, env, site, machine) {
  if (request.headers.get('Upgrade') !== 'websocket') return errorResponse('expected_websocket', 426);

  const { token, subprotocol } = extractToken(request);
  const verdict = await verifySignalToken(token, env);
  if (!verdict.ok) return errorResponse(verdict.code, verdict.code === 'missing_token' ? 401 : 403);

  const { claims } = verdict;
  // The path is a readability aid, not an authority: it must agree with the token.
  if (claims.site !== site || claims.machine !== machine) return errorResponse('room_mismatch', 403);

  const headers = new Headers(request.headers);
  headers.set('x-swoop-role', claims.role);
  headers.set('x-swoop-id', claims.role === 'viewer' ? claims.viewer : claims.role);
  headers.set('x-swoop-sid', claims.sid || '');
  headers.set('x-swoop-ctl', claims.ctl ? '1' : '0');
  if (subprotocol) headers.set('x-swoop-subprotocol', subprotocol);
  // The room never sees the token itself.
  headers.delete('Authorization');
  headers.delete('Sec-WebSocket-Protocol');

  return roomStub(env, claims.site, claims.machine).fetch('https://swoop-signal/join', {
    headers,
    // Cloudflare requires the upgrade header to survive the internal hop.
    method: request.method,
  });
}

// /v1/ring and /v1/kill are called by the Owlette API, not by clients: they are
// authenticated by the shared ring secret (SWOOP_SIGNAL_RING_SECRET, must-match
// across mirror targets) and carry an opaque sid and nothing else.
async function handleServerCall(request, env, roomPath) {
  if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
  if (!constantTimeEquals(request.headers.get('x-swoop-ring-secret'), env.SWOOP_SIGNAL_RING_SECRET)) {
    return errorResponse('bad_ring_secret', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('malformed_body', 400);
  }
  if (typeof body.site !== 'string' || typeof body.machine !== 'string') {
    return errorResponse('bad_body', 400);
  }

  return roomStub(env, body.site, body.machine).fetch(`https://swoop-signal${roomPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid: body.sid ?? null, sentAtMs: body.sentAtMs ?? null }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const summary = await keysetSummary(env).catch(() => ({ kids: [], algorithm: null }));
      return json({
        ok: summary.kids.length > 0,
        service: 'swoop-signal-spike',
        ed25519Algorithm: summary.algorithm,
        kids: summary.kids,
        // The edge colo that served this probe. Deliberately touches no Durable
        // Object: the first access to a room name pins that room's home location
        // for good, and that has to be the agent's dial, not a health check.
        colo: request.cf ? request.cf.colo : null,
        serverTimeMs: Date.now(),
      });
    }

    if (url.pathname === '/v1/ring') return handleServerCall(request, env, '/ring');
    if (url.pathname === '/v1/kill') return handleServerCall(request, env, '/kill');

    const room = url.pathname.match(/^\/v1\/room\/([^/]+)\/([^/]+)$/);
    if (room) return handleRoom(request, env, decodeURIComponent(room[1]), decodeURIComponent(room[2]));

    return errorResponse('not_found', 404);
  },
};
