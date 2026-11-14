/**
 * the machine this browser runs on, as far as swoop has learned it.
 *
 * a page cannot know which computer it is on, but a machine can: its streamer
 * ends a session whose viewer reaches it at one of its own addresses, with
 * the `same_machine` reason. the page records that here, and the dashboard
 * greys swoop out for that machine in this browser from then on. a session
 * that does connect to it proves the record wrong and clears it.
 *
 * per browser, by design: it describes this browser, not the user. storage
 * that is missing or refused (a private window, blocked site data) just
 * means the machine is not greyed out, and its streamer still says no.
 */

const KEY = 'owlette.swoop.thisMachine';

const key = (siteId: string, machineId: string) => `${siteId}/${machineId}`;

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function isThisMachine(siteId: string, machineId: string): boolean {
  return read() === key(siteId, machineId);
}

export function markThisMachine(siteId: string, machineId: string): void {
  try {
    localStorage.setItem(KEY, key(siteId, machineId));
  } catch {
    // unstorable: the streamer refusing is the guard that matters
  }
}

export function clearThisMachine(siteId: string, machineId: string): void {
  if (!isThisMachine(siteId, machineId)) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // unstorable either way
  }
}

/**
 * for `useSyncExternalStore`: the swoop tab marks the machine and the
 * dashboard tab hears it through the `storage` event.
 */
export function subscribeThisMachine(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}
