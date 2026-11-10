/**
 * fleet sessions: the short-lived, fleet-only credential a granted machine's
 * local script presents on `/api/agent/fleet/*`. it is good for nothing else,
 * and only its sha-256 is stored (`fleet_sessions/{hash}`), so a read of the
 * collection gives nothing to present.
 */

import { createHash, randomBytes } from 'crypto';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { toEpochMillis } from '@/lib/apiKeyTypes';
import logger from '@/lib/logger';

export const FLEET_SESSION_TTL_MS = 15 * 60 * 1000;

const FLEET_SESSIONS_COLLECTION = 'fleet_sessions';
const TOKEN_PREFIX = 'owf_';
const TOKEN_PATTERN = /^owf_[A-Za-z0-9_-]{43}$/;

// a rotation leaves the previous session alive this long, so a call the script
// started on it just before the rotation still verifies.
const ROTATION_GRACE_MS = 60 * 1000;

const DELETE_BATCH_SIZE = 100;

export interface FleetSessionSubject {
  siteId: string;
  machineId: string;
}

function hashFleetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function deleteRefsInBatches(db: Firestore, refs: DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + DELETE_BATCH_SIZE)) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

export async function mintFleetSession(
  db: Firestore,
  { siteId, machineId }: FleetSessionSubject,
): Promise<{ token: string; expiresAt: number }> {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const hash = hashFleetToken(token);
  const now = Date.now();
  const expiresAt = now + FLEET_SESSION_TTL_MS;
  const sessions = db.collection(FLEET_SESSIONS_COLLECTION);

  await sessions.doc(hash).set({ siteId, machineId, createdAt: now, expiresAt });

  // best-effort: an older session dies at its own expiry anyway, so a failure
  // here must not cost the machine the session it just minted.
  try {
    const snap = await sessions
      .where('siteId', '==', siteId)
      .where('machineId', '==', machineId)
      .get();
    const graceEnds = now + ROTATION_GRACE_MS;
    const dead: DocumentReference[] = [];
    for (const doc of snap.docs) {
      if (doc.id === hash) continue;
      const otherExpiry = toEpochMillis(doc.data().expiresAt);
      if (otherExpiry === null || otherExpiry <= now) {
        dead.push(doc.ref);
      } else if (otherExpiry > graceEnds) {
        await doc.ref.update({ expiresAt: graceEnds });
      }
    }
    await deleteRefsInBatches(db, dead);
  } catch (err) {
    logger.warn(
      `[fleet] could not retire older sessions after minting ${hash.slice(0, 8)}: ${errorMessage(err)}`,
    );
  }

  return { token, expiresAt };
}

export async function verifyFleetSession(
  db: Firestore,
  token: string,
): Promise<FleetSessionSubject | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = hashFleetToken(token);
  const ref = db.collection(FLEET_SESSIONS_COLLECTION).doc(hash);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const data = snap.data() ?? {};
  const expiresAt = toEpochMillis(data.expiresAt);
  if (expiresAt === null || typeof data.siteId !== 'string' || typeof data.machineId !== 'string') {
    return null;
  }
  if (expiresAt <= Date.now()) {
    try {
      await ref.delete();
    } catch (err) {
      logger.warn(`[fleet] could not delete expired session ${hash.slice(0, 8)}: ${errorMessage(err)}`);
    }
    return null;
  }
  return { siteId: data.siteId, machineId: data.machineId };
}

export async function revokeFleetSessions(
  db: Firestore,
  { siteId, machineId }: { siteId: string; machineId?: string },
): Promise<number> {
  let query = db.collection(FLEET_SESSIONS_COLLECTION).where('siteId', '==', siteId);
  // `!== undefined`, not truthiness: an empty machine id must match nothing,
  // never widen a one-machine revoke to the whole site.
  if (machineId !== undefined) {
    query = query.where('machineId', '==', machineId);
  }
  const snap = await query.get();
  return deleteRefsInBatches(db, snap.docs.map((doc) => doc.ref));
}
