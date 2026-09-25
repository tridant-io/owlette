/**
 * continuity: a control session's step-up outlives the 10-minute window for
 * as long as the browser tab does.
 *
 * owner ruling (2026-09-24): coming back to a tab after hours must not land on
 * the passkey screen. so a control grant carries a continuity token — a random
 * secret bound to that session — which the tab keeps in memory only and
 * presents on its next mint instead of a proof. the server honours it when the
 * session it names was this user's control session on this machine, its
 * secret matches, it has not been spent, and the session did not end by a
 * kill, a deliberate close or a revocation. a new tab has no token and asks
 * as before; closing the tab forgets it.
 *
 * what is stored is the secret's sha-256, never the secret, so a read of the
 * session record gives nothing to present. spending is one-shot: the mint
 * that inherits marks the old record, and the new session carries a fresh
 * token, so a captured token buys at most one reconnect and only before the
 * tab itself uses it.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SwoopSession } from '@/lib/swoop/sessionStore.server';

/** ends a session must not be resumed from without a fresh ceremony. */
const FINAL_ENDS = new Set<NonNullable<SwoopSession['endReason']>>(['closed', 'killed', 'revoked']);

const SECRET_BYTES = 32;
const TOKEN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

export interface Continuity {
  /** what the grant carries: `<sid>.<secret>`. */
  token: string;
  /** what the session record stores. */
  hash: string;
}

export function mintContinuity(sid: string): Continuity {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return { token: `${sid}.${secret}`, hash: continuityHash(secret) };
}

export function continuityHash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** the sid the token names and the hash of its secret, or null for anything malformed. */
export function parseContinuity(token: unknown): { sid: string; hash: string } | null {
  if (typeof token !== 'string') return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  return { sid: m[1], hash: continuityHash(m[2]) };
}

export type ContinuityVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_session' | 'not_yours' | 'not_control' | 'secret_mismatch' | 'spent' | 'ended_for_good' };

/**
 * whether a presented token lets this user skip the ceremony for a new control
 * session on the same machine. pure: the record was read by the caller.
 */
export function continuityInherits(args: {
  record: SwoopSession | null;
  userId: string;
  hash: string;
}): ContinuityVerdict {
  const { record, userId, hash } = args;
  if (!record) return { ok: false, reason: 'no_session' };
  if (record.createdBy !== `user:${userId}`) return { ok: false, reason: 'not_yours' };
  if (!record.viewers.some((v) => v.uid === userId && v.ctl)) return { ok: false, reason: 'not_control' };
  const stored = record.continuityHash;
  if (!stored || stored.length !== hash.length || !timingSafeEqual(Buffer.from(stored), Buffer.from(hash))) {
    return { ok: false, reason: 'secret_mismatch' };
  }
  if (record.continuityUsedAt !== undefined) return { ok: false, reason: 'spent' };
  if (record.endReason && FINAL_ENDS.has(record.endReason)) return { ok: false, reason: 'ended_for_good' };
  return { ok: true };
}
