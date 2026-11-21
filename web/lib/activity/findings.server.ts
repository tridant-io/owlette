import { emailSettingsFrom, type ActivityEmailSettings } from './emailSettings.server';
import { ACTIVITY_FINDINGS_COLLECTION, ACTIVITY_STATE_DOC, type Finding } from './types';

type Db = FirebaseFirestore.Firestore;

const ALREADY_EXISTS = 6;

export interface ActivityState {
  scannedThrough: number | null;
  lastDigestDay: string | null;
  email: ActivityEmailSettings;
}

const findings = (db: Db) => db.collection(ACTIVITY_FINDINGS_COLLECTION);

/** returns only the findings this call created; a finding seen before is not new. */
export async function saveNewFindings(db: Db, found: Finding[], now: number): Promise<Finding[]> {
  const created: Finding[] = [];
  for (const finding of found) {
    try {
      // firestore rejects undefined fields
      const subject = Object.fromEntries(Object.entries(finding.subject).filter(([, v]) => v !== undefined));
      await findings(db).doc(finding.id).create({ ...finding, subject, detectedAt: now, emailedAt: null, digestedAt: null });
      created.push(finding);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code !== ALREADY_EXISTS && code !== 'already-exists') throw err;
    }
  }
  return created;
}

export async function claimForEmail(db: Db, id: string, now: number): Promise<boolean> {
  const ref = findings(db).doc(id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('emailedAt') != null) return false;
    tx.update(ref, { emailedAt: now });
    return true;
  });
}

export async function claimDigest(db: Db, day: string): Promise<boolean> {
  const ref = db.doc(ACTIVITY_STATE_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get('lastDigestDay') === day) return false;
    tx.set(ref, { lastDigestDay: day }, { merge: true });
    return true;
  });
}

export async function markDigested(db: Db, ids: string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  const batch = db.batch();
  for (const id of ids) batch.update(findings(db).doc(id), { digestedAt: now });
  await batch.commit();
}

export async function readState(db: Db): Promise<ActivityState> {
  const snap = await db.doc(ACTIVITY_STATE_DOC).get();
  return {
    scannedThrough: typeof snap.get('scannedThrough') === 'number' ? snap.get('scannedThrough') : null,
    lastDigestDay: snap.get('lastDigestDay') ?? null,
    email: emailSettingsFrom(snap),
  };
}

export async function writeScannedThrough(db: Db, at: number): Promise<void> {
  await db.doc(ACTIVITY_STATE_DOC).set({ scannedThrough: at }, { merge: true });
}
