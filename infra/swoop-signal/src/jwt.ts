// EdDSA (ed25519) jwt verification through webcrypto.
//
// PROTOCOL.md section 8 is the claim table and section 11 fixes the order of
// checks; both are normative, and the refusal codes below are the `reason` strings
// of the golden vectors in agent/swoop/testdata/protocol/jwt/.
//
// nothing in this module logs, returns or throws token material. a failure is a
// short code and nothing else.

import { ID_PATTERN, isRole, LIMITS, type Role } from './messages';

// measured on workerd 1.20260917.1 (spike 0.4 section 3.1): importKey accepts
// "Ed25519", "ed25519" (normalised to "Ed25519") and the legacy
// "NODE-ED25519" + namedCurve form, but a key imported under the legacy name keeps
// it as its algorithm identity and the two cannot be mixed. one constant, no branch.
export const ED25519_ALGORITHM = 'Ed25519';

const ISSUER = 'owlette-api';

// section 8: a viewer token is minted for the streamer and presented to the worker
// on the way past, so its audience is swoop-host, not swoop-signal.
const AUDIENCE_BY_ROLE: Readonly<Record<Role, string>> = {
  viewer: 'swoop-host',
  host: 'swoop-signal',
  doorbell: 'swoop-signal',
};

// section 8: viewer exp <= 60 s after iat, host and doorbell <= 300 s.
const MAX_TTL_S_BY_ROLE: Readonly<Record<Role, number>> = {
  viewer: 60,
  host: 300,
  doorbell: 300,
};

const CLOCK_SKEW_S = 30;
// section 11: "<hash-func> <HEX:WITH:COLONS>", hash token lowercase, hex uppercase.
const FINGERPRINT_PATTERN = /^[a-z0-9-]{1,16} (?:[0-9A-F]{2}:)+[0-9A-F]{2}$/;

export interface JwtEnv {
  SWOOP_JWT_KID?: string;
  SWOOP_JWT_PUBLIC_KEY?: string;
  // the previous key during a rotation overlap. unset outside one, and that is the
  // steady state — but the pair must exist so a rotation is not a flag day
  // (review-3 F6.3, PROTOCOL.md section 11 "key rotation").
  SWOOP_JWT_KID_PREV?: string;
  SWOOP_JWT_PUBLIC_KEY_PREV?: string;
}

export interface SwoopClaims {
  iss: string;
  aud: string;
  role: Role;
  site: string;
  machine: string;
  sid?: string;
  viewer?: string;
  uid?: string;
  ctl?: boolean;
  fp?: string;
  iat: number;
  exp: number;
  jti: string;
}

export type VerifyRefusal =
  | 'missing_token'
  | 'malformed_token'
  | 'bad_alg'
  | 'unknown_kid'
  | 'keyset_unavailable'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'bad_role'
  | 'expired'
  | 'not_yet_valid'
  | 'ttl_too_long'
  | 'fp_missing'
  | 'fp_malformed'
  | 'bad_claims'
  | 'site_mismatch'
  | 'machine_mismatch';

export type VerifyResult = { ok: true; claims: SwoopClaims } | { ok: false; code: VerifyRefusal };

export interface VerifyOptions {
  /** the room the url named. a token that disagrees is refused (section 11 step 6). */
  expect?: { site?: string; machine?: string };
  /** injectable for the golden vectors, which are signed against a fixed anchor. */
  nowMs?: number;
}

let keysetCacheSource: string | null = null;
let keysetCache: Map<string, CryptoKey> | null = null;

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * at most two active public keys: the current one and, during a rotation overlap,
 * the previous one. both verify; outside an overlap only the current pair is set.
 * keys are base64url raw 32-byte ed25519 public keys.
 */
async function loadKeyset(env: JwtEnv): Promise<Map<string, CryptoKey>> {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [env.SWOOP_JWT_KID, env.SWOOP_JWT_PUBLIC_KEY],
    [env.SWOOP_JWT_KID_PREV, env.SWOOP_JWT_PUBLIC_KEY_PREV],
  ];
  const source = JSON.stringify(pairs);
  if (keysetCacheSource === source && keysetCache) return keysetCache;

  const keyset = new Map<string, CryptoKey>();
  for (const [kid, key] of pairs) {
    if (!kid || !key) continue;
    const bytes = base64UrlToBytes(key);
    if (bytes.length !== 32) throw new Error('bad_key_length');
    keyset.set(kid, await crypto.subtle.importKey('raw', bytes, { name: ED25519_ALGORITHM }, false, ['verify']));
  }
  if (keyset.size === 0) throw new Error('keyset_empty');

  keysetCacheSource = source;
  keysetCache = keyset;
  return keyset;
}

/** the active kids, for the ring-secret-authenticated half of /health. no key material. */
export async function keysetSummary(env: JwtEnv): Promise<{ kids: string[]; algorithm: string }> {
  return { kids: [...(await loadKeyset(env)).keys()], algorithm: ED25519_ALGORITHM };
}

function fail(code: VerifyRefusal): VerifyResult {
  return { ok: false, code };
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * verifies a swoop jwt in the order PROTOCOL.md section 11 makes normative:
 * kid -> signature -> iss/aud/role -> exp -> fp -> site/machine/sid -> jti.
 * `jti` single use is not here: it needs durable state and lives in the room.
 */
export async function verifySwoopToken(
  token: string | null,
  env: JwtEnv,
  options: VerifyOptions = {}
): Promise<VerifyResult> {
  const nowS = Math.floor((options.nowMs ?? Date.now()) / 1000);

  if (typeof token !== 'string' || token.length === 0) return fail('missing_token');
  if (token.length > LIMITS.tokenBytes) return fail('malformed_token');

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed_token');

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]) as Record<string, unknown>;
    claims = decodeSegment(parts[1]) as Record<string, unknown>;
  } catch {
    return fail('malformed_token');
  }
  if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return fail('malformed_token');

  // 1. kid. the key cannot be selected before the header is read, which is why kid
  // precedes the signature. never fall back to trying every key.
  if (header.alg !== 'EdDSA') return fail('bad_alg');
  if (header.typ !== undefined && header.typ !== 'JWT') return fail('bad_alg');
  if (typeof header.kid !== 'string') return fail('unknown_kid');

  let keyset: Map<string, CryptoKey>;
  try {
    keyset = await loadKeyset(env);
  } catch {
    return fail('keyset_unavailable');
  }
  const key = keyset.get(header.kid);
  if (!key) return fail('unknown_kid');

  // 2. signature.
  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      { name: ED25519_ALGORITHM },
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
  } catch {
    return fail('malformed_token');
  }
  if (!valid) return fail('bad_signature');

  // 3. iss / aud / role.
  if (claims.iss !== ISSUER) return fail('bad_issuer');
  if (!isRole(claims.role)) return fail('bad_role');
  const role: Role = claims.role;
  if (claims.aud !== AUDIENCE_BY_ROLE[role]) return fail('bad_audience');

  // 4. exp. absence is a refusal, never a pass.
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return fail('expired');
  if (typeof claims.iat !== 'number' || !Number.isFinite(claims.iat)) return fail('bad_claims');
  if (claims.exp <= nowS - CLOCK_SKEW_S) return fail('expired');
  if (claims.iat > nowS + CLOCK_SKEW_S) return fail('not_yet_valid');
  if (claims.exp - claims.iat > MAX_TTL_S_BY_ROLE[role]) return fail('ttl_too_long');

  // 5. fp. mandatory on a viewer token and never allowed to degrade to "no binding
  // required": a 60 s bearer token with no binding defeats the whole defence. the
  // worker cannot compare it — it has no offer — so it checks presence and shape,
  // and the streamer does the comparison.
  if (role === 'viewer') {
    if (typeof claims.fp !== 'string' || claims.fp.length === 0) return fail('fp_missing');
    if (!FINGERPRINT_PATTERN.test(claims.fp)) return fail('fp_malformed');
  }

  // 6. site / machine / sid.
  if (typeof claims.site !== 'string' || !ID_PATTERN.test(claims.site)) return fail('bad_claims');
  if (typeof claims.machine !== 'string' || !ID_PATTERN.test(claims.machine)) return fail('bad_claims');
  if (role === 'doorbell') {
    // a doorbell names no session.
    if (claims.sid !== undefined && claims.sid !== null) return fail('bad_claims');
  } else if (typeof claims.sid !== 'string' || !ID_PATTERN.test(claims.sid)) {
    return fail('bad_claims');
  }
  if (role === 'viewer') {
    if (typeof claims.viewer !== 'string' || !ID_PATTERN.test(claims.viewer)) return fail('bad_claims');
    if (typeof claims.uid !== 'string' || !ID_PATTERN.test(claims.uid)) return fail('bad_claims');
    if (claims.ctl !== undefined && typeof claims.ctl !== 'boolean') return fail('bad_claims');
  }
  if (options.expect?.site !== undefined && options.expect.site !== claims.site) return fail('site_mismatch');
  if (options.expect?.machine !== undefined && options.expect.machine !== claims.machine) {
    return fail('machine_mismatch');
  }

  // 7. jti. single use is enforced by the room, which has durable state.
  if (typeof claims.jti !== 'string' || !ID_PATTERN.test(claims.jti)) return fail('bad_claims');

  return { ok: true, claims: claims as unknown as SwoopClaims };
}
