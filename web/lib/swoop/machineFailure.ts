/**
 * the reasons a machine ends a session with before it shows a picture, and
 * what the page says for each. the agent posts them as `session_ended` (a
 * refusal to spawn, or the streamer's exit reason) so the record carries
 * them; the viewer reads the record when its retry is due and stops on one
 * of these instead of asking again — asking every few seconds is what trips
 * the machine's spawn ceiling (elm-fort laptop, 2026-10-15: five
 * `no_capture_source` deaths, then `spawn_rate_ceiling`, shown as
 * "connecting" for as long as the tab was open).
 *
 * the keys are the agent's `REFUSAL_*` and `EXIT_REASONS` names in
 * `agent/src/swoop_spawn.py`. a name there that is missing here is recorded
 * as `host_exit` and retried as before: `desktop_not_running` and
 * `no_console_session` are left out on purpose, since the service relaunches
 * the desktop app on its own and someone signing in clears the other.
 */
export const MACHINE_FAILURE_COPY = {
  no_capture_source: "this machine can't capture its screen right now. its display may be asleep or off, or its screen-capture service did not answer.",
  no_encoder: "this machine has no video encoder swoop can use at its display's size.",
  spawn_failed: "this machine's agent could not start the swoop streamer.",
  spawn_rate_ceiling: 'this machine refused: too many swoop starts in a short time. it accepts another in about ten minutes.',
  bundle_unavailable: "this machine's agent could not fetch the session from the server.",
  not_installed: 'swoop is not installed on this machine.',
  install_unverified: "this machine's swoop install did not pass its integrity check.",
  version_mismatch: "this machine's swoop streamer does not match its agent version.",
  bundle_invalid: 'this machine rejected the session the server sent it.',
} as const;

export type SwoopMachineFailureReason = keyof typeof MACHINE_FAILURE_COPY;

export const MACHINE_FAILURE_REASONS = Object.keys(MACHINE_FAILURE_COPY) as readonly SwoopMachineFailureReason[];

/**
 * a streamer that died at start may have hit a bad moment — a display that
 * was asleep, an encoder busy elsewhere — so these stop the ladder only on
 * the second in a row. every other reason is the agent's own refusal and
 * stops it at once.
 */
const STOPS_ON_REPEAT: ReadonlySet<SwoopMachineFailureReason> = new Set<SwoopMachineFailureReason>([
  'no_capture_source',
  'no_encoder',
  'spawn_failed',
]);

/** the sentence for a recorded end reason, or null when it is not a machine failure. */
export function machineFailureCopy(reason: unknown): string | null {
  return typeof reason === 'string' && Object.hasOwn(MACHINE_FAILURE_COPY, reason)
    ? MACHINE_FAILURE_COPY[reason as SwoopMachineFailureReason]
    : null;
}

/** whether `reason` ends the ladder, given the reason the session before it ended with. */
export function machineFailureStops(reason: string, previous: string | null): boolean {
  if (machineFailureCopy(reason) === null) return false;
  return !STOPS_ON_REPEAT.has(reason as SwoopMachineFailureReason) || previous === reason;
}
