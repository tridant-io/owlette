/**
 * A machine's own way into hoot: the machine menu links `/hoot?site=&machine=`,
 * and the hoot page reads it once, aims a fresh chat at that machine and drops
 * the query from the url. One module, so both ends agree on the names.
 */

export interface HootMachineLink {
  siteId: string;
  machineId: string;
}

export function hootMachineHref(siteId: string, machineId: string): string {
  return `/hoot?${new URLSearchParams({ site: siteId, machine: machineId })}`;
}

/** The link in a url's query, or null unless it names both a site and a machine. */
export function readHootMachineLink(search: string): HootMachineLink | null {
  const params = new URLSearchParams(search);
  const siteId = params.get('site');
  const machineId = params.get('machine');
  return siteId && machineId ? { siteId, machineId } : null;
}
