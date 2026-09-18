// the wire vocabulary of PROTOCOL.md section 2, in one place. the room is a dumb
// pipe: every authorisation decision was made by the api before the token was
// minted, so all the room enforces is who may send what, and to whom.

export const SWOOP_PROTOCOL_VERSION = 1;

// PROTOCOL.md section 1: the subprotocol is the first place the version integer is
// asserted. a browser cannot set handshake headers, so it also carries the token as
// a second subprotocol token.
export const SUBPROTOCOL = 'owlette.swoop.v1';
export const TOKEN_SUBPROTOCOL_PREFIX = 'jwt.';

export type Role = 'viewer' | 'host' | 'doorbell';

export const ROLES: readonly Role[] = ['viewer', 'host', 'doorbell'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

// PROTOCOL.md section 8: the shape of every site, machine, sid, viewer and jti.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// server-only types. a client that sends one is refused: it cannot forge a ring or
// a kill over its own socket.
const SERVER_ONLY_TYPES: ReadonlySet<string> = new Set(['hello', 'ring', 'viewer-join', 'kill', 'error']);

// the send-rights half of PROTOCOL.md section 2's table.
const CLIENT_SEND_RIGHTS: Readonly<Record<string, readonly Role[]>> = {
  offer: ['viewer'],
  answer: ['host'],
  'host-ready': ['host'],
  candidate: ['viewer', 'host'],
  bye: ['viewer', 'host'],
};

export type SendRefusal = 'forbidden_type' | 'unknown_type' | 'wrong_role';

export type SendVerdict = { ok: true } | { ok: false; code: SendRefusal };

/** who may send what (PROTOCOL.md section 2). shape and size are checked by the caller. */
export function classifyClientMessage(type: unknown, role: Role): SendVerdict {
  if (typeof type !== 'string') return { ok: false, code: 'unknown_type' };
  if (SERVER_ONLY_TYPES.has(type)) return { ok: false, code: 'forbidden_type' };
  const allowed = Object.prototype.hasOwnProperty.call(CLIENT_SEND_RIGHTS, type)
    ? CLIENT_SEND_RIGHTS[type]
    : undefined;
  if (!allowed) return { ok: false, code: 'unknown_type' };
  if (!allowed.includes(role)) return { ok: false, code: 'wrong_role' };
  return { ok: true };
}

/**
 * the fan-out rule is directional: a viewer only ever reaches the agent side, and
 * the agent side reaches the named viewer or every viewer. a viewer never reaches
 * another viewer.
 */
export function fansToAgentSide(role: Role): boolean {
  return role === 'viewer';
}

// flood limits. every number is here rather than scattered through the room.
export const LIMITS = {
  /** 4 KiB. a swoop token is ~700 bytes; anything larger is not one of ours. */
  tokenBytes: 4096,
  /** 64 KiB per frame — PROTOCOL.md section 2's `message_too_large`. an sdp offer is a few KiB. */
  messageBytes: 65536,
  /** 120 frames per 10 s per connection. trickle ice is bursty; a well-behaved peer stays far below. */
  messagesPerWindow: 120,
  messageWindowMs: 10000,
  /** 4 concurrent viewers per machine. more than a handful of watchers is not a swoop session. */
  viewersPerRoom: 4,
  /** 10 rings per 60 s per machine (review-2 M5): each accepted ring spawns a SYSTEM process on a customer box. */
  ringsPerWindow: 10,
  ringWindowMs: 60000,
  /** serializeAttachment()'s hard ceiling. ours is ~200 bytes; refuse at join rather than discover at runtime. */
  attachmentBytes: 16384,
} as const;

// close codes in the private range. the doorbell (task 2.3) and the browser both
// branch on these, so they are contract.
export const CLOSE_CODES = {
  /** 4000 + http 401. the socket's own token stopped being acceptable: re-mint and redial, do not back off. */
  auth: 4401,
  /** a flood limit was exceeded. back off. */
  flood: 4008,
} as const;

/**
 * the auth-signal vocabulary, and it is exactly three words. the doorbell does one
 * free re-mint and redials at once when it sees any of them, and walks the full
 * backoff ladder on anything else — without that, a kid rotation costs every
 * machine in the fleet a ladder instead of a sub-second re-mint.
 *
 * the same three values appear on all three surfaces: the `x-swoop-error` header
 * of a refused handshake, the `code` of that refusal's body, and the `code` of the
 * error frame sent immediately before an auth close. one vocabulary, not three.
 */
export type AuthSignal = 'auth' | 'token_expired' | 'unknown_kid';
