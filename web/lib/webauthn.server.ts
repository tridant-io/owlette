/**
 * WebAuthn RP config, challenge storage, and credential persistence.
 * Server-only — never import from a client component.
 *
 * RETIRED FIELD `users/{uid}.passkeyEnrolled`: a non-transactional boolean that could
 * disagree with the subcollection it summarized. The authoritative count is
 * `users/{uid}.mfaFactors.passkeys`, recounted transactionally by `applyMfaFactorChange`
 * (lib/mfaFactors.server.ts). Old user docs still carry the field; a stale value is inert.
 * Do not reintroduce a writer for it.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import { isProduction } from '@/lib/resendClient.server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/server';

const RP_NAME = 'Owlette';

/**
 * E2E override for the relying-party identity. Checked BEFORE the production branch on
 * purpose — do NOT collapse it into the dev fall-through: the Playwright harness serves a
 * production Next build (`next({ dev: false })`, NODE_ENV inlined at build time), so without
 * it getRpId() returns 'owlette.app' and no loopback ceremony can verify.
 *
 * Gated on OWLETTE_E2E === '1' (set only by playwright.config.ts) and only when a value is
 * supplied, so a run that forgets the vars falls through instead of running with an empty
 * origin allowlist.
 */
function e2eRpOverride(name: 'WEBAUTHN_RP_ID' | 'WEBAUTHN_ORIGINS'): string | null {
  if (process.env.OWLETTE_E2E !== '1') {
    return null;
  }
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function getRpId(): string {
  const e2eRpId = e2eRpOverride('WEBAUTHN_RP_ID');
  if (e2eRpId) {
    return e2eRpId;
  }
  if (process.env.NODE_ENV === 'production') {
    return 'owlette.app';
  }
  return 'localhost';
}

export function getExpectedOrigins(): string[] {
  // Comma-separated: a spec may need more than one loopback origin.
  const e2eOrigins = e2eRpOverride('WEBAUTHN_ORIGINS')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (e2eOrigins && e2eOrigins.length > 0) {
    return e2eOrigins;
  }
  if (process.env.NODE_ENV === 'production') {
    // each deployment accepts its own origin only
    return [isProduction ? 'https://owlette.app' : 'https://dev.owlette.app'];
  }
  return ['http://localhost:3000'];
}

export function getRpName(): string {
  return RP_NAME;
}

export interface StoredPasskey {
  credentialId: string;
  credentialPublicKey: string; // base64url-encoded
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  deviceType: string;
  backedUp: boolean;
  friendlyName: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface PasskeyInfo {
  credentialId: string;
  friendlyName: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string;
}

interface StoredChallenge {
  challenge: string;
  userId: string | null;
  type: 'registration' | 'authentication';
  createdAt: Date;
  expiresAt: Date;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function storeChallenge(
  challengeId: string,
  challenge: string,
  userId: string | null,
  type: 'registration' | 'authentication'
): Promise<void> {
  const db = getAdminDb();
  await db.collection('webauthn_challenges').doc(challengeId).set({
    challenge,
    userId,
    type,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
}

export async function getAndDeleteChallenge(
  challengeId: string
): Promise<StoredChallenge | null> {
  const db = getAdminDb();
  const docRef = db.collection('webauthn_challenges').doc(challengeId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return null;
  }

  const data = doc.data() as StoredChallenge;

  // Single-use.
  await docRef.delete();

  const expiresAt = data.expiresAt instanceof Date
    ? data.expiresAt
    : new Date((data.expiresAt as { _seconds: number })._seconds * 1000);

  if (Date.now() > expiresAt.getTime()) {
    return null;
  }

  return data;
}

export async function getUserPasskeys(userId: string): Promise<StoredPasskey[]> {
  const db = getAdminDb();
  const snapshot = await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      credentialId: doc.id,
      credentialPublicKey: data.credentialPublicKey,
      counter: data.counter,
      transports: data.transports,
      deviceType: data.deviceType,
      backedUp: data.backedUp,
      friendlyName: data.friendlyName,
      createdAt: data.createdAt?.toDate?.() ?? new Date(data.createdAt),
      lastUsedAt: data.lastUsedAt?.toDate?.() ?? new Date(data.lastUsedAt),
    };
  });
}

export async function storePasskey(
  userId: string,
  credential: {
    credentialId: string;
    credentialPublicKey: string;
    counter: number;
    transports?: AuthenticatorTransportFuture[];
    deviceType: string;
    backedUp: boolean;
  },
  friendlyName: string
): Promise<void> {
  const db = getAdminDb();

  // Credential document only. The factor tally belongs to
  // `applyMfaFactorChange({ recountPasskeys: true })`, which the caller runs next and which
  // counts this subcollection in a transaction — a summary flag written here could not be.
  const passkeyRef = db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credential.credentialId);

  await passkeyRef.set({
    credentialPublicKey: credential.credentialPublicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    friendlyName,
    createdAt: new Date(),
    lastUsedAt: new Date(),
  });
}

export async function deletePasskey(
  userId: string,
  credentialId: string
): Promise<void> {
  const db = getAdminDb();

  // Document only. Whether this was the last passkey is decided by the caller's
  // `applyMfaFactorChange({ recountPasskeys })`, which owns the zero-case consequences
  // (re-arming requiresMfaSetup, revoking trusted devices).
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .delete();
}

export async function updatePasskeyCounter(
  userId: string,
  credentialId: string,
  newCounter: number
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .update({
      counter: newCounter,
      lastUsedAt: new Date(),
    });
}

export async function renamePasskey(
  userId: string,
  credentialId: string,
  friendlyName: string
): Promise<void> {
  const db = getAdminDb();
  await db
    .collection('users')
    .doc(userId)
    .collection('passkeys')
    .doc(credentialId)
    .update({ friendlyName });
}

export async function getPasskeyListInfo(userId: string): Promise<PasskeyInfo[]> {
  const passkeys = await getUserPasskeys(userId);
  return passkeys.map((p) => ({
    credentialId: p.credentialId,
    friendlyName: p.friendlyName,
    deviceType: p.deviceType,
    backedUp: p.backedUp,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt.toISOString(),
  }));
}
