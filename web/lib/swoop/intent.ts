/**
 * what a session asks for, and when the ask steps down.
 *
 * the page asks for control first: an operator who opened the page to take
 * over should not have to say so. the control ask is refused with
 * `capability_missing` when the person's site role or swoop mode does not
 * include control, and the viewer then asks to watch. only that refusal
 * steps the ask down; every other refusal is the answer.
 */

/** the route's capability gate, or swoop's own, saying this user may not control. */
export function controlRefusedForCapability(status: number, code: string | null, detail: string): boolean {
  if (status !== 403) return false;
  return code === 'capability_missing' || /capability not granted/i.test(detail);
}
