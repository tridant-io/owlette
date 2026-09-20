// swoop signaling worker — routing, the ring secret, and nothing else.
//
// the durable object's name is derived from the *verified token's* site and
// machine claims and never from a client-supplied path or query value, so a client
// cannot address another machine's room by asking for it. the room never sees the
// token: the worker strips Authorization and Sec-WebSocket-Protocol and forwards
// resolved identity as x-swoop-* headers on the internal hop.

import { isId, LIMITS, SUBPROTOCOL, TOKEN_SUBPROTOCOL_PREFIX } from './messages';
import { keysetSummary, verifySwoopToken, type JwtEnv, type VerifyRefusal } from './jwt';
import { SignalRoom } from './room';

export { SignalRoom };

export interface Env extends JwtEnv {
  SIGNAL_ROOM: DurableObjectNamespace;
  SWOOP_SIGNAL_RING_SECRET?: string;
}

// a refusal a client can fix by minting a fresh token, versus one it cannot. the
// doorbell's reconnect loop (task 2.3 / spike 0.6) branches on this: `auth` means
// re-mint and redial at once — a kid rotation must not cost every machine in the
// fleet a full backoff ladder — anything else means back off.
type Reason = 'auth' | 'room' | 'protocol' | 'server';

/**
 * every verifier refusal collapses to one of three wire codes. the detail stays
 * inside the worker: a refusal tells the caller only whether a fresh token could
 * fix it, which is all a client can act on and all an attacker should learn.
 */
const AUTH_STATUS: Readonly<Record<VerifyRefusal, { status: number; reason: Reason; code: string }>> = {
  missing_token: { status: 401, reason: 'auth', code: 'auth' },
  malformed_token: { status: 401, reason: 'auth', code: 'auth' },
  bad_alg: { status: 401, reason: 'auth', code: 'auth' },
  bad_signature: { status: 401, reason: 'auth', code: 'auth' },
  bad_issuer: { status: 401, reason: 'auth', code: 'auth' },
  bad_audience: { status: 401, reason: 'auth', code: 'auth' },
  bad_role: { status: 401, reason: 'auth', code: 'auth' },
  not_yet_valid: { status: 401, reason: 'auth', code: 'auth' },
  ttl_too_long: { status: 401, reason: 'auth', code: 'auth' },
  fp_missing: { status: 401, reason: 'auth', code: 'auth' },
  fp_malformed: { status: 401, reason: 'auth', code: 'auth' },
  bad_claims: { status: 401, reason: 'auth', code: 'auth' },
  // the two the client can act on more cheaply than a blind re-mint.
  expired: { status: 401, reason: 'auth', code: 'token_expired' },
  unknown_kid: { status: 401, reason: 'auth', code: 'unknown_kid' },
  // PROTOCOL.md section 2 names this one on the wire, whatever the verifier called
  // it internally: the url disagreed with the token, and no re-mint fixes that.
  site_mismatch: { status: 403, reason: 'room', code: 'room_mismatch' },
  machine_mismatch: { status: 403, reason: 'room', code: 'room_mismatch' },
  // a deployment without a keyset is our fault, not the caller's.
  keyset_unavailable: { status: 500, reason: 'server', code: 'keyset_unavailable' },
};

function refuse(code: string, status: number, reason: Reason): Response {
  return Response.json(
    { type: 'error', reason, code },
    // the header exists because a websocket client that fails the handshake often
    // surfaces the status and headers but not the body.
    { status, headers: { 'x-swoop-error': code } }
  );
}

// browsers cannot set headers on a websocket handshake, so a viewer carries its
// token as a second subprotocol. only the plain subprotocol is echoed back, and the
// token never appears in a url or a response header — and so never in an access log.
function extractToken(request: Request): { token: string | null; offered: boolean; badSubprotocol: boolean } {
  const header = request.headers.get('Sec-WebSocket-Protocol');
  const parts = header ? header.split(',').map((part) => part.trim()) : [];
  // PROTOCOL.md section 1: a worker that does not recognise the subprotocol refuses
  // the upgrade. an agent dialling with the Authorization header may offer none.
  if (parts.length > 0 && !parts.includes(SUBPROTOCOL)) return { token: null, offered: false, badSubprotocol: true };
  const offered = parts.includes(SUBPROTOCOL);

  const authorization = request.headers.get('Authorization');
  if (authorization && authorization.startsWith('Bearer ')) {
    return { token: authorization.slice(7), offered, badSubprotocol: false };
  }
  const carrier = parts.find((part) => part.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
  return {
    token: carrier ? carrier.slice(TOKEN_SUBPROTOCOL_PREFIX.length) : null,
    offered,
    badSubprotocol: false,
  };
}

function constantTimeEquals(a: string | null, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function roomStub(env: Env, site: string, machine: string): DurableObjectStub {
  return env.SIGNAL_ROOM.get(env.SIGNAL_ROOM.idFromName(`${site}:${machine}`));
}

async function handleRoom(request: Request, env: Env, site: string, machine: string): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return refuse('expected_websocket', 426, 'protocol');
  }

  const { token, offered, badSubprotocol } = extractToken(request);
  if (badSubprotocol) return refuse('bad_subprotocol', 400, 'protocol');

  const verdict = await verifySwoopToken(token, env, { expect: { site, machine } });
  if (!verdict.ok) {
    const mapped = AUTH_STATUS[verdict.code];
    return refuse(mapped.code, mapped.status, mapped.reason);
  }

  const { claims } = verdict;
  const headers = new Headers(request.headers);
  headers.set('x-swoop-role', claims.role);
  headers.set('x-swoop-id', claims.role === 'viewer' ? (claims.viewer as string) : claims.role);
  headers.set('x-swoop-sid', claims.sid ?? '');
  headers.set('x-swoop-ctl', claims.ctl ? '1' : '0');
  headers.set('x-swoop-jti', claims.jti);
  headers.set('x-swoop-exp-ms', String(claims.exp * 1000));
  // rfc 6455: only echo a subprotocol the client actually offered.
  if (offered) headers.set('x-swoop-subprotocol', SUBPROTOCOL);
  headers.delete('Authorization');
  headers.delete('Sec-WebSocket-Protocol');

  return roomStub(env, claims.site, claims.machine).fetch('https://swoop-signal/join', {
    method: request.method,
    headers,
  });
}

/** the ring secret, compared in constant time before anything else happens. */
function ringSecretVerdict(request: Request, env: Env): Response | null {
  if (!env.SWOOP_SIGNAL_RING_SECRET) return refuse('ring_secret_unconfigured', 500, 'server');
  if (!constantTimeEquals(request.headers.get('x-swoop-ring-secret'), env.SWOOP_SIGNAL_RING_SECRET)) {
    return refuse('bad_ring_secret', 401, 'auth');
  }
  return null;
}

// /v1/ring and /v1/kill are called by the owlette api, never by a client. the body
// is an allow-list: PROTOCOL.md section 11's "a sid and nothing else" is about
// session *content* — no bundle, no jwt, no key, no turn credential, no viewer id,
// no uid — so anything outside {site, machine, sid} is a refusal rather than
// something to ignore.
const RING_FIELDS: ReadonlySet<string> = new Set(['site', 'machine', 'sid']);

async function handleServerCall(request: Request, env: Env, roomPath: '/ring' | '/kill'): Promise<Response> {
  if (request.method !== 'POST') return refuse('method_not_allowed', 405, 'protocol');
  const denied = ringSecretVerdict(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return refuse('malformed_body', 400, 'protocol');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse('malformed_body', 400, 'protocol');
  if (Object.keys(body).some((key) => !RING_FIELDS.has(key))) return refuse('unexpected_field', 400, 'protocol');

  const { site, machine, sid } = body;
  if (!isId(site) || !isId(machine)) return refuse('bad_room', 400, 'protocol');
  // a kill may name no session — "kill whatever is running". a ring always names one.
  const sidOk = roomPath === '/kill' ? sid === null || sid === undefined || isId(sid) : isId(sid);
  if (!sidOk) return refuse('bad_sid', 400, 'protocol');

  // THE ONE PLACE a room name arrives as payload rather than from a verified token.
  // it is not a bug and it is not a hole: these two routes carry no token at all,
  // only the ring secret, so the caller has already been authenticated as the api
  // itself. every token-bearing route derives the room from the claims and must
  // keep doing so.
  return roomStub(env, site, machine).fetch(`https://swoop-signal${roomPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // sentAtMs is stamped here, at the edge the api reached, so the doorbell can
    // measure the ring's own delay separately from the in-room hop.
    body: JSON.stringify({ sid: sid ?? null, sentAtMs: Date.now() }),
  });
}

// unauthenticated /health is a fixed body, so it is cacheable, leaks nothing and
// never varies. it must also never touch a durable object: the first access to a
// room name pins that room's home location for good, and that has to be the
// agent's dial, not a health check.
const HEALTH_BODY = JSON.stringify({ ok: true, service: 'swoop-signal', protocolVersion: 1 });

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

// carrying the ring secret additionally reports which kids this deployment holds
// and the algorithm constant. without it a rotation is unverifiable from outside —
// one cannot tell whether the worker learned the new key before the api started
// minting with it. kids are identifiers, not key material, and nothing here can
// reach a key.
async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('x-swoop-ring-secret') === null) return json(JSON.parse(HEALTH_BODY));
  const denied = ringSecretVerdict(request, env);
  if (denied) return denied;
  const summary = await keysetSummary(env).catch(() => null);
  if (!summary) return refuse('keyset_unavailable', 500, 'server');
  return json({ ...JSON.parse(HEALTH_BODY), kids: summary.kids, algorithm: summary.algorithm });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') return handleHealth(request, env);
    if (url.pathname === '/v1/ring') return handleServerCall(request, env, '/ring');
    if (url.pathname === '/v1/kill') return handleServerCall(request, env, '/kill');

    // /v1/room/{site}/{machine} — the only route whose room comes from the url, and
    // it is checked against the token's claims rather than trusted.
    const room = url.pathname.match(/^\/v1\/room\/([^/]+)\/([^/]+)$/);
    if (room) {
      const site = decodeURIComponent(room[1]);
      const machine = decodeURIComponent(room[2]);
      if (site.length > LIMITS.tokenBytes || machine.length > LIMITS.tokenBytes) {
        return refuse('not_found', 404, 'protocol');
      }
      return handleRoom(request, env, site, machine);
    }

    return refuse('not_found', 404, 'protocol');
  },
};
