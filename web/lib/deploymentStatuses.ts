/**
 * the target statuses the deployment routes and the dashboard both decide on.
 * no server imports here: the uninstall hook reads the same list the server
 * checks, so the dialog never sends a deployment the route would refuse.
 */

/** an install that has not started on the machine yet, so it can still be cancelled. */
export const PRE_FLIGHT_DEPLOYMENT_STATUSES = new Set<string>([
  'pending',
  'closing_processes',
  'downloading',
]);

/** a target the install is finished with, one way or another. */
export const TERMINAL_DEPLOYMENT_STATUSES = new Set<string>([
  'completed',
  'failed',
  'cancelled',
  'uninstalled',
]);
