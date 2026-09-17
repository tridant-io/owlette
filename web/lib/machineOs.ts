/**
 * The operating systems an owlette agent runs on — the wire values the agent
 * writes to `osFamily` on its machine doc. An absent field means windows.
 */
export const MACHINE_OS_FAMILIES = ['windows', 'macos', 'linux'] as const;

export type MachineOsFamily = (typeof MACHINE_OS_FAMILIES)[number];

/**
 * Narrows a raw `osFamily` off a machine doc. The agent reports an unrecognised
 * platform verbatim rather than forcing it into a bucket, so anything outside
 * the union reads as absent — which the dashboard already treats as windows.
 */
export function isMachineOsFamily(value: unknown): value is MachineOsFamily {
  return typeof value === 'string' && (MACHINE_OS_FAMILIES as readonly string[]).includes(value);
}
