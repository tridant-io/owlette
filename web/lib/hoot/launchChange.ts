/**
 * What counts as hoot changing what a machine runs, or when. The owner's ruling:
 * approval is required, always. A site's tier-3 setting can't turn this off, and a
 * turn with nobody to ask can't run it. See docs/adr/0019.
 *
 * Every tool is classified here, and anything else needs a person: a new tool, or a
 * field or action nobody has classified yet. Shared with the approval card, so no
 * server imports.
 */

import { CALL_MACHINES_PARAM } from '@/lib/mcp-tools';

/**
 * A call refused before anything is queued, in the shape the model reads.
 * A type, not an interface: it has to fit the tool results' Record<string, unknown>.
 */
export type ToolRefusal = { ok: false; error: string; detail: string; status: number };

export function toolRefusal(error: string, detail: string, status: number): ToolRefusal {
  return { ok: false, error, detail, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tools that never change what runs or when. reboot and shutdown stay with the tier-3 setting. */
const TOOLS_THAT_KEEP_WHAT_RUNS: ReadonlySet<string> = new Set([
  'get_site_logs',
  'get_system_info',
  'get_process_list',
  'get_running_processes',
  'get_gpu_processes',
  'get_network_info',
  'get_disk_usage',
  'get_event_logs',
  'get_event_logs_filtered',
  'get_service_status',
  'get_agent_config',
  'get_agent_logs',
  'get_agent_health',
  'get_system_presets',
  'check_pending_reboot',
  'schedule_followup',
  'cancel_followup',
  'list_talons',
  // run or stop what is already configured; unattended recovery depends on them.
  'restart_process',
  'start_process',
  'kill_process',
  'manage_process',
  'capture_screenshot',
  'configure_gpu_tdr',
  'suppress_setup_screens',
  'manage_notifications',
  'configure_power_plan',
  'network_reset',
  'clean_disk_space',
  'show_notification',
  'read_file',
  'list_directory',
  'reboot_machine',
  'shutdown_machine',
  'cancel_reboot',
  // the fleet's own tools, which the server answers for a granted machine.
  'list_machines',
  'get_metrics_history',
  'list_installed_software',
  'list_alert_rules',
  'get_audit_log',
  'list_recent_screenshots',
  'get_saved_display_layout',
  'get_site_display_settings',
  'get_reboot_schedule',
  'set_reboot_schedule',
  'list_deployments',
  'get_deployment',
  'list_software_presets',
  'cancel_deployment',
  'list_roosts',
  'list_roost_versions',
]);

/** Tools that always do: they name what runs, or run anything. A script can't be read for what it launches. */
const TOOLS_THAT_CHANGE_WHAT_RUNS: ReadonlySet<string> = new Set([
  'add_process',
  'delete_process',
  'set_launch_mode',
  'run_command',
  'run_powershell',
  'run_python',
  'execute_script',
  'write_file',
  'deploy_software',
  // the fleet's: each installs software on a machine.
  'create_deployment',
  'update_owlette_agent',
  'deploy_roost_version',
  'rollback_roost',
]);

/**
 * Neither what runs nor when: the display name, and how a running target sits on
 * the machine. time_delay, time_to_init and relaunch_attempts are not here, because
 * they decide when a crash relaunch happens and when it turns into a reboot.
 */
const UPDATE_PROCESS_FIELDS_THAT_KEEP_WHAT_RUNS: ReadonlySet<string> = new Set([
  'process_name',
  'name',
  'priority',
  'visibility',
]);

/** create runs any program, as SYSTEM if it likes; enable, disable, delete and run_now change what runs. */
const SCHEDULED_TASK_ACTIONS_THAT_KEEP_WHAT_RUNS: ReadonlySet<unknown> = new Set([
  'list',
  'get_details',
  'get_history',
  'stop',
]);

/** set_recovery can name a program to run as SYSTEM; set_startup decides what starts at boot. */
const SERVICE_ACTIONS_THAT_KEEP_WHAT_RUNS: ReadonlySet<unknown> = new Set([
  'start',
  'stop',
  'restart',
  'pause',
  'continue',
  'get_details',
]);

/** set_scheduled_install installs on a schedule of hoot's choosing and restarts the machine then. */
const WINDOWS_UPDATE_ACTIONS_THAT_KEEP_WHAT_RUNS: ReadonlySet<unknown> = new Set([
  'get_status',
  'pause',
  'resume',
  'set_active_hours',
  'limit_auto_restart',
  'disable_auto_install',
  'enable_auto_install',
  'set_feature_deferral',
  'set_quality_deferral',
]);

/** The outputs that don't act on a machine by themselves: a message, or hoot without the tools to act. */
function talonOutputOnlyLooks(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output.type === 'email' || output.type === 'webhook') return true;
  return output.type === 'cortex' && output.allowActions !== true;
}

/** Tools where it depends on the call. Each answers whether this call changes what runs. */
const TOOLS_DECIDED_BY_THE_CALL: ReadonlyMap<string, (params: Record<string, unknown>) => boolean> = new Map([
  ['update_process', (params) => Object.keys(params).some((key) => !UPDATE_PROCESS_FIELDS_THAT_KEEP_WHAT_RUNS.has(key))],
  ['manage_scheduled_task', (params) => !SCHEDULED_TASK_ACTIONS_THAT_KEEP_WHAT_RUNS.has(params.action)],
  ['manage_windows_service', (params) => !SERVICE_ACTIONS_THAT_KEEP_WHAT_RUNS.has(params.action)],
  ['manage_windows_update', (params) => !WINDOWS_UPDATE_ACTIONS_THAT_KEEP_WHAT_RUNS.has(params.action)],
  ['manage_windows_feature', (params) => params.action !== 'list'],
  // Winlogon's Shell and a service's ImagePath are on the agent's allowlist.
  ['registry_operation', (params) => params.action !== 'read'],
  ['create_talon', (params) => !Array.isArray(params.outputs) || !params.outputs.every(talonOutputOnlyLooks)],
  ['set_talon_enabled', (params) => params.enabled !== false],
]);

/** A test holds every tool in mcp-tools.ts to this, so a new one can't ship unclassified. */
export function isClassifiedTool(toolName: string): boolean {
  return (
    TOOLS_THAT_KEEP_WHAT_RUNS.has(toolName) ||
    TOOLS_THAT_CHANGE_WHAT_RUNS.has(toolName) ||
    TOOLS_DECIDED_BY_THE_CALL.has(toolName)
  );
}

export function changesWhatMachineLaunches(toolName: string, input: unknown): boolean {
  if (TOOLS_THAT_KEEP_WHAT_RUNS.has(toolName)) return false;
  const decide = TOOLS_DECIDED_BY_THE_CALL.get(toolName);
  return decide ? decide(isRecord(input) ? input : {}) : true;
}

/**
 * The tier a caller's own limit is held to, where no card is asked: an API key's
 * `maxToolTier`, a sender's grant. A launch change is tier 3 whatever its tool's tier.
 */
export function callTier(toolName: string, input: unknown, toolTier: 1 | 2 | 3): 1 | 2 | 3 {
  return changesWhatMachineLaunches(toolName, input) ? 3 : toolTier;
}

/**
 * Never offered to a turn that fires with nobody watching (autonomous, talons,
 * follow-ups), read-only actions included: standing policy, and tools whose whole
 * point is what runs at boot, on failure or on a schedule.
 */
export const UNATTENDED_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'create_talon',
  'set_talon_enabled',
  'manage_scheduled_task',
  'manage_windows_service',
  'registry_operation',
]);

/** Reported rather than worked round: the wording tells the model to stop here. */
export function launchChangeRefusal(): ToolRefusal {
  return toolRefusal(
    'launch_change_needs_approval',
    "this would change what a machine runs, which always needs a person's approval in a dashboard chat, and this turn can't ask for one. nothing was changed. don't try another way to do it: report it, so a person can ask for it in a dashboard chat.",
    403,
  );
}

/** For a turn with nobody present. */
export function unattendedRefusal(toolName: string, input: unknown): ToolRefusal | null {
  return changesWhatMachineLaunches(toolName, input) ? launchChangeRefusal() : null;
}

const WINLOGON_KEY = 'software\\microsoft\\windows nt\\currentversion\\winlogon';
const SERVICES_KEY = 'system\\currentcontrolset\\services';
const REGISTRY_ROOTS: ReadonlySet<string> = new Set([
  'computer',
  'hklm',
  'hkcu',
  'hkey_local_machine',
  'hkey_current_user',
]);

/*
 * The server's copy of agent/src/tools_windows.py's registry rules, here because a
 * fielded agent has the old allowlist and can't be changed from here. Both copies
 * are tested on agent/tests/fixtures/registry_refusals.json: change them together.
 */
const WINLOGON_VALUES: ReadonlySet<string> = new Set([
  'autoadminlogon',
  'defaultusername',
  'defaultdomainname',
  'forceautologon',
  'autologoncount',
]);
const SECRET_VALUE_NAME =
  /passw|passphrase|(?<![a-z])pass(?![a-z])|secret|token|credential|api.?key|access.?key|private.?key|auth/i;
const SERVICE_VALUE_THAT_RUNS =
  /dll|path|image|^app|application|command|program|library|exe|script|catalog|module|driver|handler/i;
const SERVICE_DATA_THAT_RUNS =
  /\.(?:exe|dll|sys|bat|cmd|ps1|vbs|js|scr|msi|cpl|ocx)\b|[a-z]:[\\/]|\\\\|%\w+%/i;
/** JS trim and Python strip disagree on what is whitespace, so nothing outside printable ASCII gets that far. */
const KEY_PATH_NOT_PRINTABLE_ASCII = /[^\x20-\x7e]/;

function registryKey(keyPath: string): string {
  const parts = keyPath
    .trim()
    .toLowerCase()
    .replace(/\//g, '\\')
    .split('\\')
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 0 && REGISTRY_ROOTS.has(parts[0])) parts.shift();
  return parts
    .filter((part) => part !== 'wow6432node')
    .map((part) => (/^controlset\d+$/.test(part) ? 'currentcontrolset' : part))
    .join('\\');
}

function serviceWriteRefusal(key: string, name: string, valueType: unknown, valueData: unknown): string | null {
  const parts = key.split('\\');
  const [service, parameters, ...below] = parts.slice(3);
  if (parameters !== 'parameters' || service === 'winsock2') {
    return "under a service only its Parameters key can be changed; use manage_windows_service for how it starts and recovers. nothing was changed.";
  }
  const data = typeof valueData === 'string' ? valueData : JSON.stringify(valueData ?? '');
  if (
    below.some((part) => part.startsWith('app')) ||
    SERVICE_VALUE_THAT_RUNS.test(name) ||
    SERVICE_DATA_THAT_RUNS.test(data) ||
    String(valueType ?? '').toLowerCase() === 'binary'
  ) {
    return `${name || 'this value'} can say what a service runs, so this tool won't change it. nothing was changed.`;
  }
  return null;
}

/** registry_operation on what no approval opens. See the copy note above. */
export function registryValueRefusal(toolName: string, input: unknown): ToolRefusal | null {
  if (toolName !== 'registry_operation' || !isRecord(input) || typeof input.key_path !== 'string') return null;
  const refused = (detail: string) => toolRefusal('registry_value_refused', detail, 403);
  if (KEY_PATH_NOT_PRINTABLE_ASCII.test(input.key_path)) {
    return refused('key_path holds a control character or unusual whitespace. nothing was read or changed.');
  }

  const key = registryKey(input.key_path);
  const given = input.value_name ?? '';
  const name = typeof given === 'string' ? given : '';

  if (typeof given !== 'string') return refused('value_name is not a string. nothing was read or changed.');
  if (key === WINLOGON_KEY || key.startsWith(`${WINLOGON_KEY}\\`)) {
    return key === WINLOGON_KEY && WINLOGON_VALUES.has(name.toLowerCase())
      ? null
      : refused(
          `under Winlogon only these values can be reached, each by name: ${[...WINLOGON_VALUES].join(', ')}. nothing was read or changed.`,
        );
  }
  if (name && SECRET_VALUE_NAME.test(name)) {
    return refused(`${name} looks like a secret, so this tool won't reach it. nothing was read or changed.`);
  }
  if (input.action !== 'read' && key.startsWith(`${SERVICES_KEY}\\`)) {
    const reason = serviceWriteRefusal(key, name, input.value_type, input.value_data);
    if (reason) return refused(reason);
  }
  return null;
}

/** A fielded agent lists a key's values, secrets included: they stop here on the way to the model. */
export function withoutSecretRegistryValues(toolName: string, result: unknown): unknown {
  if (toolName !== 'registry_operation' || !isRecord(result) || !Array.isArray(result.values)) return result;
  return {
    ...result,
    values: result.values.filter(
      (entry) => !(isRecord(entry) && typeof entry.name === 'string' && SECRET_VALUE_NAME.test(entry.name)),
    ),
  };
}

/** What the card leaves in the collapsed input: a change here isn't what's being approved. */
const CARD_FIELDS_LEFT_OUT: ReadonlySet<string> = new Set(['name', 'priority', 'visibility']);

/**
 * What the approval card spells out without expanding: the values being approved, in full for the person.
 * The call's machines are not among them: the server takes them out before it classifies the call, and
 * the card names them on its own.
 */
export function launchChangeInputs(toolName: string, input: Record<string, unknown>): Array<[string, string]> {
  const call = Object.entries(input).filter(([key]) => key !== CALL_MACHINES_PARAM);
  if (!changesWhatMachineLaunches(toolName, Object.fromEntries(call))) return [];
  return call
    .filter(([key]) => toolName !== 'update_process' || !CARD_FIELDS_LEFT_OUT.has(key))
    .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]);
}
