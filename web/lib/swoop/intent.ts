/**
 * what a session asks for, and when the ask steps down.
 *
 * the page asks for control first: an admin gets it, and an operator who
 * opened the page to take over should not have to say so. a member holds
 * the view capability only, and the route refuses the control ask before
 * swoop's own gate runs — so that refusal, and only that one, is answered
 * with the watch ask the site may allow (`membersMayWatch`). every other
 * refusal is the answer.
 */

/** the route's capability gate, or swoop's own, saying this user may not control. */
export function controlRefusedForCapability(status: number, code: string | null, detail: string): boolean {
  if (status !== 403) return false;
  return code === 'capability_missing' || /capability not granted/i.test(detail);
}
