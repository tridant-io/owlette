/**
 * the names behind swoop viewers, for what says who is in a session: the admin
 * swoop page's list (`app/api/sites/[siteId]/swoop/sessions`), a session's own
 * read, which names the people in it to the people in it, and the machine's
 * mirror of its seats (`syncMachineSwoopViewers`), which keeps the name alone.
 *
 * one `getAll` over `users` for every distinct viewer, however many sessions
 * or seats they hold: the members-route pattern. a missing or soft-deleted
 * account is left out of the map, so its viewer answers `NO_NAME`: the seat is
 * still taken, whoever held it.
 */

import { getAdminDb } from '@/lib/firebase-admin';
import type { SwoopSession } from '@/lib/swoop/sessionStore.server';

interface UserDoc {
  email?: unknown;
  displayName?: unknown;
  deletedAt?: unknown;
}

export interface ViewerName {
  email: string | null;
  displayName: string | null;
}

export const NO_NAME: ViewerName = { email: null, displayName: null };

export async function viewerNames(sessions: readonly SwoopSession[]): Promise<Map<string, ViewerName>> {
  const names = new Map<string, ViewerName>();
  // the store reads a viewer row with no uid as '', which is no document path.
  const uids = [
    ...new Set(sessions.flatMap((session) => session.viewers.map((viewer) => viewer.uid))),
  ].filter((uid) => uid !== '');
  if (uids.length === 0) return names;

  const db = getAdminDb();
  const snaps = await db.getAll(...uids.map((uid) => db.collection('users').doc(uid)));
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    const data = (snap.data() ?? {}) as UserDoc;
    if (typeof data.deletedAt === 'number') return;
    names.set(uids[i], {
      email: typeof data.email === 'string' ? data.email : null,
      displayName: typeof data.displayName === 'string' ? data.displayName : null,
    });
  });
  return names;
}
