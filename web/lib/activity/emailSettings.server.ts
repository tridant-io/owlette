import { isProduction } from '@/lib/resendClient.server';
import { ACTIVITY_STATE_DOC } from './types';

type Db = FirebaseFirestore.Firestore;

export interface ActivityEmailSettings {
  enabled: boolean;
  recipients: string[];
}

/** reads the two fields off a state doc snapshot: absent means on, and no addresses. */
export function emailSettingsFrom(snap: { get(field: string): unknown }): ActivityEmailSettings {
  const recipients = snap.get('emailRecipients');
  return {
    enabled: snap.get('emailEnabled') !== false,
    recipients: Array.isArray(recipients) ? recipients.filter((r): r is string => typeof r === 'string') : [],
  };
}

export async function readActivityEmailSettings(db: Db): Promise<ActivityEmailSettings> {
  return emailSettingsFrom(await db.doc(ACTIVITY_STATE_DOC).get());
}

// merge: the cron keeps its own fields on the same doc
export async function writeActivityEmailSettings(db: Db, { enabled, recipients }: ActivityEmailSettings): Promise<void> {
  await db.doc(ACTIVITY_STATE_DOC).set({ emailEnabled: enabled, emailRecipients: recipients }, { merge: true });
}

/** where mail goes while no address is set: ACTIVITY_EMAIL, else the admin address, as bug reports do. */
export function activityFallbackEmail(): string | null {
  return process.env.ACTIVITY_EMAIL || (isProduction ? process.env.ADMIN_EMAIL_PROD : process.env.ADMIN_EMAIL_DEV) || null;
}
