/**
 * who is in a swoop session, by name: the streamer's roster
 * (`lib/swoop/presence.ts`) joined on its viewer ids with the session record's
 * viewers, which the session route names to the people in the session, and
 * gives the emails of to a site owner or admin only.
 *
 * the record is read when the roster's viewers change, someone joining or
 * leaving, and never on a timer: the roster says when to look again. the bar
 * and the stage both ask, so one read per roster serves the page. this tab's
 * own name is the signed-in user's until the read lands, so it never shows as
 * "viewer" at the start of every session.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import type { SwoopSession } from '@/lib/swoop/features';
import { NO_PRESENCE, swoopPresence } from '@/lib/swoop/presence';
import { getUserShortName } from '@/lib/userUtils';

export interface SwoopNamedViewer {
  /** the roster's viewer id: one per tab or window, so one person in two tabs is two. */
  id: string;
  /** the streamer's own verdict from this viewer's token. */
  ctl: boolean;
  /** this tab's own viewer. */
  you: boolean;
  /** first name and last initial; "viewer" until the record names them. */
  short: string;
  /** the full name, as far as it is known. */
  full: string;
  /** only where the session route sent one. */
  email: string | null;
  /** the session route said this caller may kick them: never your own seats. */
  kickable: boolean;
}

interface Name {
  displayName: string | null;
  email: string | null;
  kickable: boolean;
}

type Names = ReadonlyMap<string, Name>;

const UNNAMED = 'viewer';
const NOBODY: readonly SwoopNamedViewer[] = [];

const subscribeNever = (): (() => void) => () => {};
const noPresence = () => NO_PRESENCE;

/** each session's last read, and the roster it was made for. */
const reads = new WeakMap<SwoopSession, { roster: string; names: Promise<Names | null> }>();

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** null when the read failed: what is shown stays as it was. */
async function fetchNames(session: SwoopSession): Promise<Names | null> {
  try {
    const res = await fetch(
      `/api/sites/${encodeURIComponent(session.siteId)}/machines/${encodeURIComponent(session.machineId)}/swoop/sessions/${encodeURIComponent(session.sid)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { viewers?: unknown } };
    const names = new Map<string, Name>();
    for (const viewer of Array.isArray(body.data?.viewers) ? body.data.viewers : []) {
      const { viewerId, displayName, email, kickable } = (viewer ?? {}) as Record<string, unknown>;
      if (typeof viewerId === 'string') {
        names.set(viewerId, { displayName: text(displayName), email: text(email), kickable: kickable === true });
      }
    }
    return names;
  } catch {
    return null;
  }
}

function readNames(session: SwoopSession, roster: string): Promise<Names | null> {
  const held = reads.get(session);
  if (held?.roster === roster) return held.names;
  const names = fetchNames(session);
  reads.set(session, { roster, names });
  return names;
}

export function useSwoopViewerNames(session: SwoopSession | null): readonly SwoopNamedViewer[] {
  const store = swoopPresence(session);
  const { viewers } = useSyncExternalStore(
    store?.subscribe ?? subscribeNever,
    store?.get ?? noPresence,
    noPresence,
  );
  const { user } = useAuth();
  const [names, setNames] = useState<Names | null>(null);
  // who is here, whatever order the roster lists them in
  const roster = viewers
    .map((viewer) => viewer.id)
    .sort()
    .join(' ');

  useEffect(() => {
    if (!session || roster === '') return;
    let current = true;
    void readNames(session, roster).then((read) => {
      if (current && read) setNames(read);
    });
    return () => {
      current = false;
    };
  }, [session, roster]);

  if (roster === '') return NOBODY;
  return viewers.map((viewer) => {
    const you = viewer.id === session?.viewerId;
    // an email is only ever the route's to give
    const name =
      names?.get(viewer.id) ?? (you && user ? { displayName: text(user.displayName), email: null, kickable: false } : null);
    const named = name?.displayName || name?.email ? name : null;
    return {
      id: viewer.id,
      ctl: viewer.ctl,
      you,
      short: named ? getUserShortName(named) : UNNAMED,
      full: named?.displayName ?? named?.email ?? UNNAMED,
      email: name?.email ?? null,
      kickable: name?.kickable ?? false,
    };
  });
}
