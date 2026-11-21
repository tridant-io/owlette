/**
 * moving a machine to another site, as the dashboard and the move route share
 * it: whether the machine's agent can follow, and the words a refusal uses.
 */

import { compareVersions, SITE_MOVE_MIN_AGENT_VERSION } from '@/lib/versionUtils';

/**
 * `capabilities.siteMove === 1` on an agent of 4.2.3 or later. a missing or
 * unreadable version counts as one that can't follow.
 */
export function canFollowMove(machine: {
  agentVersion?: string | null;
  capabilities?: Record<string, unknown> | null;
}): boolean {
  if (machine.capabilities?.siteMove !== 1) return false;
  return (compareVersions(machine.agentVersion, SITE_MOVE_MIN_AGENT_VERSION) ?? -1) >= 0;
}

export const MOVE_TOO_OLD = (name: string, version: string, min: string) =>
  `${name} runs owlette ${version}. moving it needs ${min} or later: update it first, or leave and join from the machine.`;

export const MOVE_EXISTS = (target: string, id: string) =>
  `${target} already has a machine named ${id}. remove it there first.`;

export const MOVE_BUSY = (name: string) =>
  `${name} is installing or syncing. try again when it finishes.`;

export const MOVE_OFFLINE = (name: string) =>
  `${name} is offline. the move waits until it comes back, for up to 7 days.`;

/** why a site can't be deleted while a machine is switching into or out of it. */
export const SITE_DELETE_MOVING = (direction: 'into' | 'out of') =>
  `a machine is moving ${direction} this site right now. try again in a minute.`;
