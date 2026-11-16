import { isProduction } from '@/lib/resendClient.server';
import { ACTIVITY_STATE_DOC } from './types';

type Db = FirebaseFirestore.Firestore;

export interface ActivityEmailSettings {
  enabled: boolean;
  recipients: string[];
}

/** ACTIVITY_EMAIL, else the admin address, as bug reports do. */
function configuredAddress(): string | undefined {
  return process.env.ACTIVITY_EMAIL || (isProduction ? process.env.ADMIN_EMAIL_PROD : process.env.ADMIN_EMAIL_DEV) || undefined;
}

/**
 * reads the two fields off a state doc snapshot. absent means on. the list is who
 * gets mail: until a superadmin saves one it starts as the configured address, and
 * once saved it is used as it is, an emptied list meaning nobody.
 */
export function emailSettingsFrom(snap: { get(field: string): unknown }): ActivityEmailSettings {
  const stored = snap.get('emailRecipients');
  const initial = configuredAddress();
  return {
    enabled: snap.get('emailEnabled') !== false,
    recipients: Array.isArray(stored)
      ? stored.filter((r): r is string => typeof r === 'string')
      : initial
        ? [initial.toLowerCase()]
        : [],
  };
}

export async function readActivityEmailSettings(db: Db): Promise<ActivityEmailSettings> {
  return emailSettingsFrom(await db.doc(ACTIVITY_STATE_DOC).get());
}

// merge: the cron keeps its own fields on the same doc
export async function writeActivityEmailSettings(db: Db, { enabled, recipients }: ActivityEmailSettings): Promise<void> {
  await db.doc(ACTIVITY_STATE_DOC).set({ emailEnabled: enabled, emailRecipients: recipients }, { merge: true });
}
