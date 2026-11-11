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

// what agents answered the deployment uninstall while it sent no program name, kept on
// targets that failed before the reconciler recorded failedCommandType. both texts come
// from agent/src/owlette_service.py, handle_firebase_command, `uninstall_software`:
const NAMELESS_UNINSTALL_ERRORS = new Set([
  // windows and macOS: the missing-name check.
  'Error: Software name and uninstall command required',
  // linux (4.x): `import registry_utils` fails on its `import winreg` before that check,
  // and the handler's outer except answers `Error: executing command {cmd_type}: {e}`.
  "Error: executing command uninstall_software: No module named 'winreg'",
]);

/**
 * a `failed` target whose failure was an uninstall. retrying it, which queues an
 * install, would put back the program someone was removing.
 */
export function failedByUninstall(target: { failedCommandType?: unknown; error?: unknown }): boolean {
  return (
    target.failedCommandType === 'uninstall_software' ||
    (typeof target.error === 'string' && NAMELESS_UNINSTALL_ERRORS.has(target.error))
  );
}

/** a `failed` target a retry may take: its install failed, not its uninstall. */
export function retryableTarget(target: { status?: unknown; failedCommandType?: unknown; error?: unknown }): boolean {
  return target.status === 'failed' && !failedByUninstall(target);
}
