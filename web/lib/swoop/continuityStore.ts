/**
 * this tab's continuity token for one machine: what lets the tab take control
 * again without a second factor, once, after its last control session.
 *
 * sessionStorage, so it lives as long as the tab does: a reload of the page
 * keeps it, and a new tab or window starts without one and asks. the server
 * still decides whether it counts (`continuity.server.ts`): it is single use,
 * bound to the user and the session it came from, and void after a kill.
 * storage that is missing or refused only means the next session asks.
 */

const key = (siteId: string, machineId: string) => `owlette.swoop.continuity/${siteId}/${machineId}`;

export function readContinuity(siteId: string, machineId: string): string | null {
  try {
    return sessionStorage.getItem(key(siteId, machineId));
  } catch {
    return null;
  }
}

export function writeContinuity(siteId: string, machineId: string, token: string | null): void {
  try {
    if (token) sessionStorage.setItem(key(siteId, machineId), token);
    else sessionStorage.removeItem(key(siteId, machineId));
  } catch {
    // unstorable: the next session asks for the second factor instead
  }
}
