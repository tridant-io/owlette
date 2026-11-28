/**
 * Creates `users/{uid}` on first sign-in/sign-up, replacing the client-side
 * setDoc calls in AuthContext so creation is server-mediated and audit-logged
 * (security-boundary-migration wave 3.9).
 *
 * Idempotent: a second call returns `already_exists`. No capability check —
 * capabilities only govern other people's resources, and this is the moment the
 * caller's own record appears; the handler asserts bearer uid == target uid.
 * Callers that need to gate creation (the bot challenge) pass `onWillCreate`
 * rather than gating the call, so a retry against an existing doc still passes.
 *
 * Defaults match the legacy AuthContext writes, plus `mfaFactors` (which it
 * never wrote) so a new account starts with the factor inventory present
 * instead of needing a read-time backfill.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '@/lib/firebase-admin';
import { emitMutation } from '@/lib/auditLogClient';
import { isValidTimezone } from '@/lib/timeUtils';
import { sanitizeDisplayName } from '@/lib/sanitize';

/** Verdict from `onWillCreate`; `reason` is handed back to the caller verbatim. */
export type BootstrapCreateGate = { ok: true } | { ok: false; reason: string };

export interface BootstrapUserInput {
  uid: string;
  email: string;
  displayName?: string;
  /** IANA tz id from the client; defaults to UTC if invalid/missing. */
  timezone?: string;
  /**
   * Gate run between the existence read and the write, and ONLY when the doc is
   * absent — so a caller's bot challenge guards account CREATION without also
   * rejecting an existing user's tokenless retry. Sharing the one read leaves no
   * window in which the gate's verdict and the write can disagree.
   */
  onWillCreate?: () => Promise<BootstrapCreateGate>;
  /** Inject a Firestore instance — tests pass a mock; production omits. */
  db?: Firestore;
  /** Inject a clock — tests pass a fixed value; production omits. */
  now?: () => Date;
}

export interface BootstrapUserContext {
  /** Audit actor string ("user:<uid>") — always the bootstrap target itself. */
  auditActor: string;
  endpoint?: string;
  method?: string;
}

export type BootstrapUserResult =
  | { kind: 'already_exists'; createdAt: number | null }
  | { kind: 'create_denied'; reason: string }
  | {
      kind: 'created';
      uid: string;
      email: string;
      displayName: string;
      timezone: string;
      createdAt: number;
    };

const UID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

export async function bootstrapUser(
  ctx: BootstrapUserContext,
  input: BootstrapUserInput,
): Promise<BootstrapUserResult> {
  if (!input.uid || !UID_REGEX.test(input.uid)) {
    throw new Error('uid is required and must match user-id format');
  }
  if (!input.email || typeof input.email !== 'string') {
    throw new Error('email is required');
  }

  const db = input.db ?? getAdminDb();
  const userRef = db.collection('users').doc(input.uid);

  // Single write chokepoint: sanitise here so a direct API caller can't bypass
  // the signup form's stripping of links / emoji-spam / invisible chars.
  const displayName = sanitizeDisplayName(input.displayName);
  const timezone =
    typeof input.timezone === 'string' && isValidTimezone(input.timezone)
      ? input.timezone
      : 'UTC';
  const nowDate = (input.now ?? (() => new Date()))();
  const createdAtMs = nowDate.getTime();

  // Not transaction create(): a retried bootstrap must return already_exists,
  // not fail.
  const existing = await userRef.get();
  if (existing.exists) {
    const data = existing.data() ?? {};
    const createdAtRaw = data.createdAt;
    let createdAt: number | null = null;
    if (typeof createdAtRaw === 'number') {
      createdAt = createdAtRaw;
    } else if (
      createdAtRaw &&
      typeof (createdAtRaw as { toMillis?: () => number }).toMillis === 'function'
    ) {
      try {
        createdAt = (createdAtRaw as { toMillis: () => number }).toMillis();
      } catch {
        createdAt = null;
      }
    }
    return { kind: 'already_exists', createdAt };
  }

  if (input.onWillCreate) {
    const verdict = await input.onWillCreate();
    if (!verdict.ok) return { kind: 'create_denied', reason: verdict.reason };
  }

  await userRef.set({
    email: input.email,
    role: 'member',
    // NO `sites: []`. That field is legacy — site access comes from
    // `sites/{siteId}/members/{uid}` — and wave 6.1 strips it. Seeding it here
    // meant the very next signup re-created what the migration had just removed,
    // so its "field is gone" gate could never converge. Readers all default a
    // missing value to [], and an empty array granted nothing anyway.
    createdAt: nowDate,
    displayName,
    mfaEnrolled: false,
    requiresMfaSetup: true,
    // Seeded inline, not via applyMfaFactorChange (the single writer everywhere
    // else): it reads the user doc first and throws when missing, which is
    // exactly the state here. Without the seed every account is born "legacy".
    mfaFactors: { totp: false, passkeys: 0, backupCodes: 0 },
    preferences: {
      temperatureUnit: 'C',
      timezone,
    },
  });

  emitMutation({
    kind: 'user_mutated',
    siteId: '',
    actor: ctx.auditActor,
    targetId: input.uid,
    attributes: {
      endpoint: ctx.endpoint ?? '',
      method: ctx.method ?? 'POST',
      verb: 'bootstrapped',
      email: input.email,
    },
  });

  return {
    kind: 'created',
    uid: input.uid,
    email: input.email,
    displayName,
    timezone,
    createdAt: createdAtMs,
  };
}
