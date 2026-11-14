/**
 * `--override-active-hours --reason <text>`, shared by the commands a guarded
 * Windows agent refuses inside the machine's active hours (reboot, shutdown,
 * deploy). Sent as `active_hours_override: { reason }`; the agent logs the
 * reason with the calling key as the approver.
 */

import type { Command } from 'commander';
import { usageFatal } from './output';

/** `doing` is what the flag lets through, e.g. "restart inside the machine's active hours anyway". */
export function addActiveHoursOverrideOptions(cmd: Command, doing: string): Command {
  return cmd
    .option('--override-active-hours', `${doing} (needs --reason)`)
    .option('--reason <text>', 'why, for --override-active-hours; written to the site log');
}

export type ActiveHoursOverrideFlags =
  | { ok: true; override?: { reason: string } }
  | { ok: false };

/** The flags as the request's `active_hours_override`; misuse is a usage error (exit 2). */
export function activeHoursOverrideFrom(opts: {
  overrideActiveHours?: boolean;
  reason?: unknown;
}): ActiveHoursOverrideFlags {
  if (!opts.overrideActiveHours) {
    if (opts.reason === undefined) return { ok: true };
    usageFatal('--reason only goes with --override-active-hours');
    return { ok: false };
  }
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (!reason) {
    usageFatal('--override-active-hours needs --reason <text>; it is written to the site log');
    return { ok: false };
  }
  return { ok: true, override: { reason } };
}
