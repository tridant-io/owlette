/**
 * this tab's codec choice for one machine: what the next session's offer
 * carries.
 *
 * the machine settles the codec once, from the browser's first offer, so a
 * choice only ever applies to a new session; the quality menu starts one, and
 * a picture that froze on a dead hevc decoder writes `h264` here before the
 * reconnect that recovers it. sessionStorage, like the continuity token beside
 * it: a reload keeps it, a new tab starts on `auto`, and storage that is
 * missing or refused only means `auto`.
 */

/** `auto` offers whatever the browser can receive, and the machine picks. */
export type SwoopCodecChoice = 'auto' | 'h264' | 'hevc';

const key = (siteId: string, machineId: string) => `owlette.swoop.codec/${siteId}/${machineId}`;

export function readCodecChoice(siteId: string, machineId: string): SwoopCodecChoice {
  try {
    const stored = sessionStorage.getItem(key(siteId, machineId));
    return stored === 'h264' || stored === 'hevc' ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeCodecChoice(siteId: string, machineId: string, choice: SwoopCodecChoice): void {
  try {
    if (choice === 'auto') sessionStorage.removeItem(key(siteId, machineId));
    else sessionStorage.setItem(key(siteId, machineId), choice);
  } catch {
    // unstorable: the next session offers the browser's own list
  }
}
