/**
 * The operating systems an owlette agent runs on — the wire values the agent
 * writes to `osFamily` on its machine doc. An absent field means windows.
 */
export type MachineOsFamily = 'windows' | 'macos' | 'linux';
