/**
 * swoop JWTs — EdDSA (ed25519) mint and verify, `node:crypto` only.
 *
 * The API is the sole minting authority (plan.md D8). The signaling Worker and
 * the streamer verify independently against a public key selected by `kid`, so
 * the relay is a dumb pipe that cannot mint.
 *
 * The verification order in `verifySwoopToken` is normative and comes from
 * `agent/swoop/PROTOCOL.md` §11: kid -> signature -> iss/aud/role -> exp -> fp
 * -> site/machine/sid -> jti. `kid` necessarily precedes the signature because
 * the key cannot be selected otherwise; an earlier draft said signature first
 * and is not implementable.
 *
 * Nothing here ever logs a token, a key or a claim set.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'crypto';
import { canonicalizeFingerprint as canonicalize } from '@/lib/swoop/protocol';

export const SWOOP_ISSUER = 'owlette-api';

export type SwoopAudience = 'swoop-signal' | 'swoop-host';
export type SwoopRole = 'viewer' | 'host' | 'doorbell';

/** PROTOCOL.md §8: a viewer token lives 60 s, host and doorbell 300 s. */
export const VIEWER_MAX_TTL_SECONDS = 60;
export const SERVICE_MAX_TTL_SECONDS = 300;

/** `site` / `machine` / `sid` shape, per PROTOCOL.md §8. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface SwoopClaims {
  iss: string;
  aud: SwoopAudience;
  role: SwoopRole;
  site: string;
  machine: string;
  sid?: string;
  /** Per-viewer id — the `info` of the `k` derivation in keys.server.ts. */
  viewer?: string;
  uid?: string;
  ctl?: boolean;
  fp?: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface MintedSwoopToken {
  token: string;
  jti: string;
  /** Unix seconds. */
  issuedAt: number;
  expiresAt: number;
}

/** Public half as the bundle carries it (PROTOCOL.md §7 `jwtKeys`). */
export interface SwoopJwtKeyEntry {
  kid: string;
  alg: 'EdDSA';
  /** base64url raw 32-byte ed25519 public key. */
  key: string;
}

export type SwoopTokenRejectReason =
  | 'malformed'
  | 'unknown_kid'
  | 'bad_alg'
  | 'bad_signature'
  | 'iss_mismatch'
  | 'aud_mismatch'
  | 'role_not_permitted'
  | 'expired'
  | 'fp_missing'
  | 'fp_mismatch'
  | 'site_mismatch'
  | 'machine_mismatch'
  | 'sid_mismatch'
  | 'jti_replayed';

export type SwoopVerifyResult =
  | { ok: true; claims: SwoopClaims }
  | { ok: false; reason: SwoopTokenRejectReason };

/** Mint-time refusal. Its message never carries claim or key material. */
export class SwoopTokenError extends Error {
  constructor(public readonly code: string) {
    super(`swoop token: ${code}`);
    this.name = 'SwoopTokenError';
  }
}

// ---------------------------------------------------------------- key loading

// DER wrappers so a raw 32-byte ed25519 key can become a KeyObject without a
// PEM round trip. Operators paste either shape into the env var.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeRawKey(value: string): Buffer | null {
  const raw = Buffer.from(value.trim(), 'base64');
  return raw.length === 32 ? raw : null;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new SwoopTokenError(`${name.toLowerCase()}_missing`);
  return value;
}

function loadPrivateKey(): KeyObject {
  const value = requiredEnv('SWOOP_JWT_PRIVATE_KEY');
  if (value.includes('BEGIN')) {
    // Railway strips real newlines out of multi-line values often enough that
    // the escaped form is what actually lands in the env.
    return createPrivateKey(value.replace(/\\n/g, '\n'));
  }
  const raw = decodeRawKey(value);
  if (!raw) throw new SwoopTokenError('swoop_jwt_private_key_malformed');
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function loadPublicKey(value: string): KeyObject {
  if (value.includes('BEGIN')) {
    return createPublicKey(value.replace(/\\n/g, '\n'));
  }
  const raw = decodeRawKey(value);
  if (!raw) throw new SwoopTokenError('swoop_jwt_public_key_malformed');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function currentKid(): string {
  return requiredEnv('SWOOP_JWT_KID');
}

/**
 * The public keys a verifier may select by `kid`, newest first — this is what
 * the bundle's `jwtKeys` carries. An array because PROTOCOL.md §11 rotates with
 * a two-key overlap; the previous key joins this list when the rotation env
 * slot lands, and nothing downstream changes shape.
 */
export function swoopJwtPublicKeys(): SwoopJwtKeyEntry[] {
  const key = loadPublicKey(requiredEnv('SWOOP_JWT_PUBLIC_KEY'));
  const raw = key.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length);
  return [{ kid: currentKid(), alg: 'EdDSA', key: raw.toString('base64url') }];
}

// -------------------------------------------------------------------- helpers

function b64url(value: object | Buffer): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  return buf.toString('base64url');
}

/**
 * `<hash-func> <HEX:WITH:COLONS>`, hash token lowercase, hex uppercase —
 * PROTOCOL.md §11. Returns null for anything that is not a fingerprint, which
 * is what makes `fp` mandatory rather than "present but meaningless".
 *
 * The canonical form comes from `lib/swoop/protocol.ts` — the browser derives
 * `fp` with it, so a second implementation here would be the exact drift
 * PROTOCOL.md warns about. This only widens the input to `unknown`, because
 * claims arrive as untrusted JSON.
 */
export function canonicalizeFingerprint(value: unknown): string | null {
  return typeof value === 'string' ? canonicalize(value) : null;
}

function assertId(value: string, field: string): void {
  if (!ID_PATTERN.test(value)) throw new SwoopTokenError(`${field}_invalid`);
}

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

function mint(claims: Omit<SwoopClaims, 'iss' | 'jti'>): MintedSwoopToken {
  const jti = randomUUID();
  const header = { alg: 'EdDSA', typ: 'JWT', kid: currentKid() };
  const payload: SwoopClaims = { iss: SWOOP_ISSUER, jti, ...claims };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = edSign(null, Buffer.from(signingInput, 'utf8'), loadPrivateKey());
  return {
    token: `${signingInput}.${b64url(signature)}`,
    jti,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}

// ---------------------------------------------------------------------- mint

export function mintViewerToken(args: {
  uid: string;
  site: string;
  machine: string;
  sid: string;
  viewer: string;
  ctl: boolean;
  fp: string;
  ttlSeconds?: number;
  now?: number;
}): MintedSwoopToken {
  assertId(args.site, 'site');
  assertId(args.machine, 'machine');
  assertId(args.sid, 'sid');
  assertId(args.viewer, 'viewer');
  if (!args.uid) throw new SwoopTokenError('uid_missing');

  // Mandatory, and refused at MINT so a token with no browser binding cannot
  // exist to be replayed — PROTOCOL.md §11, "Fingerprint binding".
  const fp = canonicalizeFingerprint(args.fp);
  if (!fp) throw new SwoopTokenError('fp_missing');

  const iat = nowSeconds(args.now);
  const ttl = Math.min(args.ttlSeconds ?? VIEWER_MAX_TTL_SECONDS, VIEWER_MAX_TTL_SECONDS);
  if (ttl <= 0) throw new SwoopTokenError('ttl_invalid');

  return mint({
    aud: 'swoop-host',
    role: 'viewer',
    site: args.site,
    machine: args.machine,
    sid: args.sid,
    viewer: args.viewer,
    uid: args.uid,
    ctl: args.ctl,
    fp,
    iat,
    exp: iat + ttl,
  });
}

export function mintHostToken(args: {
  site: string;
  machine: string;
  sid: string;
  ttlSeconds?: number;
  now?: number;
}): MintedSwoopToken {
  assertId(args.site, 'site');
  assertId(args.machine, 'machine');
  assertId(args.sid, 'sid');
  const iat = nowSeconds(args.now);
  const ttl = Math.min(args.ttlSeconds ?? SERVICE_MAX_TTL_SECONDS, SERVICE_MAX_TTL_SECONDS);
  if (ttl <= 0) throw new SwoopTokenError('ttl_invalid');
  return mint({
    aud: 'swoop-signal',
    role: 'host',
    site: args.site,
    machine: args.machine,
    sid: args.sid,
    iat,
    exp: iat + ttl,
  });
}

/** A doorbell names no session — it is the socket an idle machine parks on. */
export function mintDoorbellToken(args: {
  site: string;
  machine: string;
  ttlSeconds?: number;
  now?: number;
}): MintedSwoopToken {
  assertId(args.site, 'site');
  assertId(args.machine, 'machine');
  const iat = nowSeconds(args.now);
  const ttl = Math.min(args.ttlSeconds ?? SERVICE_MAX_TTL_SECONDS, SERVICE_MAX_TTL_SECONDS);
  if (ttl <= 0) throw new SwoopTokenError('ttl_invalid');
  return mint({
    aud: 'swoop-signal',
    role: 'doorbell',
    site: args.site,
    machine: args.machine,
    iat,
    exp: iat + ttl,
  });
}

// -------------------------------------------------------------------- verify

export interface SwoopVerifyOptions {
  /** The verifier's own audience. A token minted for the other one is refused. */
  audience: SwoopAudience;
  /** Roles this verifier accepts for the message at hand. */
  roles?: readonly SwoopRole[];
  site?: string;
  machine?: string;
  sid?: string;
  /** The DTLS fingerprint actually observed, when there is one to compare. */
  fingerprint?: string;
  /** Unix seconds. Callers with a time anchor pass it rather than wall clock. */
  now?: number;
  /** `jti` single use, where the verifier has durable state to answer from. */
  jtiSeen?: (jti: string) => boolean;
}

function reject(reason: SwoopTokenRejectReason): SwoopVerifyResult {
  return { ok: false, reason };
}

function parseSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifySwoopToken(token: string, opts: SwoopVerifyOptions): SwoopVerifyResult {
  if (typeof token !== 'string') return reject('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) return reject('malformed');

  const header = parseSegment(parts[0]);
  if (!header) return reject('malformed');

  // 1. kid selects the key. Never "try every key until one works".
  const keys = swoopJwtPublicKeys();
  const entry = typeof header.kid === 'string' ? keys.find((k) => k.kid === header.kid) : undefined;
  if (!entry) return reject('unknown_kid');

  // 2. signature, with alg pinned to EdDSA — `none` included.
  if (header.alg !== 'EdDSA') return reject('bad_alg');
  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      loadPublicKey(entry.key),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    return reject('bad_signature');
  }
  if (!signatureOk) return reject('bad_signature');

  const payload = parseSegment(parts[1]);
  if (!payload) return reject('malformed');

  // 3. iss / aud / role.
  if (payload.iss !== SWOOP_ISSUER) return reject('iss_mismatch');
  if (payload.aud !== opts.audience) return reject('aud_mismatch');
  const role = payload.role;
  if (role !== 'viewer' && role !== 'host' && role !== 'doorbell') {
    return reject('role_not_permitted');
  }
  if (opts.roles && !opts.roles.includes(role)) return reject('role_not_permitted');

  // 4. exp. Absent is a refusal, not "no expiry".
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return reject('expired');
  if (exp <= nowSeconds(opts.now)) return reject('expired');

  // 5. fp — mandatory on a viewer token, and compared against the live offer
  // when the caller has one.
  const fp = canonicalizeFingerprint(payload.fp);
  if (role === 'viewer') {
    if (!fp) return reject('fp_missing');
    if (opts.fingerprint) {
      const observed = canonicalizeFingerprint(opts.fingerprint);
      if (!observed || !constantTimeEquals(fp, observed)) return reject('fp_mismatch');
    }
  }

  // 6. site / machine / sid. A token for another machine is refused even when
  // the room or URL says otherwise.
  if (typeof payload.site !== 'string' || typeof payload.machine !== 'string') {
    return reject('malformed');
  }
  if (opts.site && payload.site !== opts.site) return reject('site_mismatch');
  if (opts.machine && payload.machine !== opts.machine) return reject('machine_mismatch');
  if (opts.sid && payload.sid !== opts.sid) return reject('sid_mismatch');

  // 7. jti, single use where there is durable state to enforce it.
  const jti = payload.jti;
  if (typeof jti !== 'string' || !jti) return reject('malformed');
  if (opts.jtiSeen?.(jti)) return reject('jti_replayed');

  const iat = typeof payload.iat === 'number' ? payload.iat : 0;
  return {
    ok: true,
    claims: {
      iss: SWOOP_ISSUER,
      aud: opts.audience,
      role,
      site: payload.site,
      machine: payload.machine,
      ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
      ...(typeof payload.viewer === 'string' ? { viewer: payload.viewer } : {}),
      ...(typeof payload.uid === 'string' ? { uid: payload.uid } : {}),
      ...(typeof payload.ctl === 'boolean' ? { ctl: payload.ctl } : {}),
      ...(fp ? { fp } : {}),
      iat,
      exp,
      jti,
    },
  };
}
