/**
 * swoop key derivation — derived on demand, never persisted.
 *
 *   K_session = HKDF-SHA256(SWOOP_SESSION_MASTER_KEY, salt "owlette-swoop/session/v1", info sid,      L 32)
 *   k         = HKDF-SHA256(K_session,                salt "owlette-swoop/viewer/v1",  info viewerId, L 32)
 *
 * The salt, info and length literals are load-bearing: the Rust streamer and
 * the browser derive against the same ones, so a drift is a silent interop
 * failure rather than a test failure. They are normative in
 * `agent/swoop/PROTOCOL.md` §11 and must not be reworded here.
 *
 * `info = sid` alone, because a sid identifies ONE streamer lifetime on ONE
 * machine — later viewers attach to the live sid and are separated by
 * `viewerId`, never by a new sid.
 *
 * Neither value is ever written to Firestore, a command document, a log or
 * disk. A viewer receives its own `k`; `K_session` goes only to the streamer,
 * in the bundle, and to nobody else. HKDF is one-way, so a viewer holding `k`
 * recovers neither `K_session` nor another viewer's `k`.
 */

import { hkdfSync } from 'crypto';

export const SESSION_HKDF_SALT = 'owlette-swoop/session/v1';
export const VIEWER_HKDF_SALT = 'owlette-swoop/viewer/v1';
export const SWOOP_KEY_LENGTH = 32;

/** Derivation refusal. Its message never carries key material. */
export class SwoopKeyError extends Error {
  constructor(public readonly code: string) {
    super(`swoop keys: ${code}`);
    this.name = 'SwoopKeyError';
  }
}

function hkdf(ikm: Buffer, salt: string, info: string): Buffer {
  // hkdfSync returns an ArrayBuffer; everything downstream wants a Buffer.
  return Buffer.from(
    hkdfSync('sha256', ikm, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), SWOOP_KEY_LENGTH),
  );
}

function masterKey(): Buffer {
  const value = process.env.SWOOP_SESSION_MASTER_KEY;
  if (!value) throw new SwoopKeyError('swoop_session_master_key_missing');
  return Buffer.from(value, 'utf8');
}

function requireInfo(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SwoopKeyError(`${field}_missing`);
  }
  return value;
}

/** `K_session`. Goes to the streamer in the bundle and to nobody else. */
export function deriveSessionKey(sid: string): Buffer {
  return hkdf(masterKey(), SESSION_HKDF_SALT, requireInfo(sid, 'sid'));
}

/** `k` — the one key a viewer is ever given. */
export function deriveViewerKey(sid: string, viewerId: string): Buffer {
  return hkdf(deriveSessionKey(sid), VIEWER_HKDF_SALT, requireInfo(viewerId, 'viewer_id'));
}

/** `sessionKey` as the bundle carries it (PROTOCOL.md §7): base64url, 32 bytes. */
export function sessionKeyForBundle(sid: string): string {
  return deriveSessionKey(sid).toString('base64url');
}

/** `k` as the session response carries it. Never `K_session`. */
export function viewerKeyForResponse(sid: string, viewerId: string): string {
  return deriveViewerKey(sid, viewerId).toString('base64url');
}
