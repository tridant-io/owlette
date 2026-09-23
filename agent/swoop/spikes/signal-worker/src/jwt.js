// EdDSA (Ed25519) JWT verification through WebCrypto, with a two-key keyset so a
// signing-key rotation is not a flag day (review-3-delivery.md F6.3).
//
// Nothing in this module ever logs or returns token material: failures surface as
// a short code only.

// Measured on workerd via wrangler 4.134.0: importKey accepts "Ed25519",
// "ed25519" (normalised to "Ed25519") and the legacy "NODE-ED25519" + namedCurve
// form, but a key imported under the legacy name keeps it as its algorithm
// identity, so the two cannot be mixed. "Ed25519" is the name to use.
export const ED25519_ALGORITHM = 'Ed25519';

const ISSUER = 'owlette-api';
const AUDIENCE = 'swoop-signal';
const ROLES = new Set(['viewer', 'host', 'doorbell']);
const CLOCK_SKEW_S = 30;
const MAX_TTL_S = 300;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let keysetCacheSource = null;
let keysetCache = null;

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// env.SWOOP_JWT_PUBLIC_KEYS is a JSON array of {kid, key} where key is a
// base64url-encoded 32-byte raw Ed25519 public key. Two entries = an overlap
// window; the API signs with one kid while both stay accepted.
async function loadKeyset(env) {
  const source = env.SWOOP_JWT_PUBLIC_KEYS;
  if (!source) throw new Error('keyset_missing');
  if (keysetCacheSource === source && keysetCache) return keysetCache;

  const entries = JSON.parse(source);
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('keyset_empty');
  if (entries.length > 2) throw new Error('keyset_too_large');

  const keyset = new Map();
  for (const entry of entries) {
    const bytes = base64UrlToBytes(entry.key);
    if (bytes.length !== 32) throw new Error('keyset_bad_key_length');
    keyset.set(entry.kid, await crypto.subtle.importKey('raw', bytes, { name: ED25519_ALGORITHM }, false, ['verify']));
  }
  keysetCacheSource = source;
  keysetCache = keyset;
  return keyset;
}

export async function keysetSummary(env) {
  const keyset = await loadKeyset(env);
  return { kids: [...keyset.keys()], algorithm: ED25519_ALGORITHM };
}

function fail(code) {
  return { ok: false, code };
}

/**
 * Verifies a swoop signaling JWT and returns its claims.
 * Resolves to {ok: true, claims} or {ok: false, code} — never to token material.
 */
export async function verifySignalToken(token, env, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length === 0) return fail('missing_token');
  if (token.length > 4096) return fail('malformed_token');

  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed_token');

  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch {
    return fail('malformed_token');
  }

  if (header.alg !== 'EdDSA') return fail('bad_alg');
  if (header.typ && header.typ !== 'JWT') return fail('bad_alg');
  if (typeof header.kid !== 'string') return fail('unknown_kid');

  let keyset;
  try {
    keyset = await loadKeyset(env);
  } catch {
    return fail('keyset_unavailable');
  }
  const key = keyset.get(header.kid);
  if (!key) return fail('unknown_kid');

  const signature = base64UrlToBytes(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify({ name: ED25519_ALGORITHM }, key, signature, signed);
  if (!valid) return fail('bad_signature');

  const nowS = Math.floor(nowMs / 1000);
  if (claims.iss !== ISSUER) return fail('bad_issuer');
  if (claims.aud !== AUDIENCE) return fail('bad_audience');
  if (!ROLES.has(claims.role)) return fail('bad_role');
  if (typeof claims.exp !== 'number') return fail('bad_claims');
  if (claims.exp <= nowS - CLOCK_SKEW_S) return fail('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowS + CLOCK_SKEW_S) return fail('not_yet_valid');
  if (typeof claims.iat === 'number' && claims.exp - claims.iat > MAX_TTL_S) return fail('ttl_too_long');
  if (!ID_PATTERN.test(claims.site || '')) return fail('bad_claims');
  if (!ID_PATTERN.test(claims.machine || '')) return fail('bad_claims');
  if (claims.role === 'viewer' && !ID_PATTERN.test(claims.viewer || '')) return fail('bad_claims');
  if (claims.role !== 'doorbell' && !ID_PATTERN.test(claims.sid || '')) return fail('bad_claims');

  return { ok: true, claims };
}
