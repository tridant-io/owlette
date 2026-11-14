/** @jest-environment node */

import { readFileSync } from 'fs';
import { join } from 'path';
import { allTools, type McpToolDefinition } from '@/lib/mcp-tools';
import { hasToolSchema, toolParamRefusal, toolSchemaGaps } from '@/lib/toolParamValidation';

const RQ = '\u201d';
const LQ = '\u201c';
const P = "Set-Content -LiteralPath 'c:/x/marker.txt' -Value x";

function agentSource(file: string): string {
  return readFileSync(join(__dirname, '..', '..', '..', 'agent', 'src', file), 'utf8');
}

/** The tool names in a python dict of `'name': handler` lines. */
function handlerNames(source: string, opening: string): string[] {
  const body = source.slice(source.indexOf(opening));
  const block = body.slice(0, body.search(/\r?\n\s*\}/));
  return [...block.matchAll(/^\s+'([a-z_]+)':\s+\w+,/gm)].map((match) => match[1]);
}

describe('every tool has a schema', () => {
  it('every parameter of every definition has a rule, and no rule is stale', () => {
    expect(toolSchemaGaps()).toEqual([]);
  });

  it.each(allTools.map((tool) => tool.name))('%s', (name) => {
    expect(hasToolSchema(name)).toBe(true);
  });

  it.each([
    ['mcp_tools.py', 'handlers = {'],
    ['tools_windows.py', 'HANDLERS = {'],
    ['tools_posix.py', 'HANDLERS = {'],
  ])('every handler in agent/src/%s has one', (file, opening) => {
    const names = handlerNames(agentSource(file), opening);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((name) => !hasToolSchema(name))).toEqual([]);
  });

  it('run_python, which the service answers itself, has one', () => {
    expect(agentSource('owlette_service.py')).toContain("tool_name == 'run_python'");
    expect(hasToolSchema('run_python')).toBe(true);
  });

  it('a name no agent or definition knows is refused', () => {
    expect(toolParamRefusal('not_a_real_tool', {})).toContain('unknown tool');
  });

  it('a parameter no definition names is refused', () => {
    expect(toolParamRefusal('get_system_info', { verbose: true })).toContain('verbose');
    expect(toolParamRefusal('get_event_logs', { log_name: 'System', ComputerName: 'x' })).toContain('ComputerName');
  });

  it('a value that is not an object is refused', () => {
    expect(toolParamRefusal('get_system_info', 'x')).not.toBeNull();
    expect(toolParamRefusal('get_system_info', null)).not.toBeNull();
    expect(toolParamRefusal('get_system_info', [])).not.toBeNull();
  });

  it('a required parameter is required', () => {
    expect(toolParamRefusal('get_service_status', {})).toContain('service_name');
  });

  it('a refusal never repeats the value', () => {
    expect(toolParamRefusal('get_event_logs', { log_name: `Application; ${P}` })).not.toContain('Set-Content');
    expect(toolParamRefusal('manage_windows_feature', { type: 'capability', action: 'list', name_filter: P })).not.toContain('Set-Content');
  });
});

describe('refused', () => {
  const task = (over: Record<string, unknown>) => ({ action: 'create', task_name: 't', ...over });
  const hostile: Array<[string, string, Record<string, unknown>]> = [
    ['get_event_logs.log_name', 'get_event_logs', { log_name: `Application -Newest 1; ${P}; #` }],
    ['get_event_logs.log_name option', 'get_event_logs', { log_name: 'Application -ComputerName other' }],
    ['get_event_logs.level', 'get_event_logs', { level: `Error; ${P}; #` }],
    ['get_event_logs.max_events', 'get_event_logs', { max_events: `1; ${P}` }],
    ['filtered.process_name', 'get_event_logs_filtered', { log_name: 'Application', process_name: `x'+(${P})+'` }],
    ['filtered.log_name', 'get_event_logs_filtered', { log_name: `Application'; ${P}` }],
    ['feature.name_filter', 'manage_windows_feature', { type: 'appx_package', action: 'list', name_filter: `x${RQ}}; ${P}; Get-Date | Where-Object {${LQ}y` }],
    ['feature.name', 'manage_windows_feature', { type: 'capability', action: 'install', name: `x${RQ}; ${P}; #` }],
    ['feature.name wildcard', 'manage_windows_feature', { type: 'appx_package', action: 'remove', name: 'Microsoft.W*' }],
    ['toast.title', 'show_notification', { title: `x'; ${P}; $y='`, message: 'm' }],
    ['toast.message', 'show_notification', { message: `x'; ${P}; $y='` }],
    ['toast.message typographic', 'show_notification', { message: `x\u2019; ${P}; $y=\u2019` }],
    ['task.name', 'manage_scheduled_task', { action: 'get_history', task_name: `x${RQ}; ${P}; #` }],
    ['task.description', 'manage_scheduled_task', task({ description: `x${RQ}; ${P}; #` })],
    ['task.trigger.user', 'manage_scheduled_task', task({ trigger: { type: 'logon', user: `x${RQ}; ${P}; #` } })],
    ['task.trigger.start_datetime', 'manage_scheduled_task', task({ trigger: { type: 'once', start_datetime: `x${RQ}; ${P}; #` } })],
    ['task.trigger.start_time', 'manage_scheduled_task', task({ trigger: { type: 'daily', start_time: `x${RQ}; ${P}; #` } })],
    ['task.trigger.log_name', 'manage_scheduled_task', task({ trigger: { type: 'on_event', event_id: 1, log_name: `x'; ${P}; #` } })],
    ['task.trigger.source', 'manage_scheduled_task', task({ trigger: { type: 'on_event', event_id: 1, source: `; ${P}; #` } })],
    ['task.trigger.source expression', 'manage_scheduled_task', task({ trigger: { type: 'on_event', event_id: 1, source: '+(Get-Date)+' } })],
    ['task.trigger.source operator', 'manage_scheduled_task', task({ trigger: { type: 'on_event', event_id: 1, source: ' -f ' } })],
    ['task.trigger.unknown field', 'manage_scheduled_task', task({ trigger: { type: 'boot', evil: 1 } })],
    ['task.action.program', 'manage_scheduled_task', task({ trigger: { type: 'boot' }, task_action: { program: `x${RQ}; ${P}; #` } })],
    ['task.action.arguments', 'manage_scheduled_task', task({ trigger: { type: 'boot' }, task_action: { program: 'a.exe', arguments: `x${RQ}; ${P}; #` } })],
    ['task.action.working_directory', 'manage_scheduled_task', task({ trigger: { type: 'boot' }, task_action: { program: 'a.exe', working_directory: `x${RQ}; ${P}; #` } })],
    ['service.leading dash', 'get_service_status', { service_name: '-Hroot@host.example' }],
    ['service.manage leading dash', 'manage_windows_service', { service_name: '--version', action: 'start' }],
    ['service.shell', 'manage_windows_service', { service_name: `x & ${P}`, action: 'start' }],
    ['adapter', 'network_reset', { action: 'restart_adapter', adapter_name: `x; ${P}` }],
    ['app', 'manage_notifications', { action: 'disable_for_app', app_name: 'a\\b' }],
    ['registry key', 'registry_operation', { action: 'read', hive: 'HKLM', key_path: 'SOFTWARE\\\u0000x' }],
    ['screen', 'capture_screenshot', { monitor: `0; ${P}` }],
    ['disk', 'clean_disk_space', { target: 'temp', older_than_days: -1 }],
  ];

  it.each(hostile)('%s', (_label, tool, params) => {
    expect(toolParamRefusal(tool, params)).not.toBeNull();
  });
});

describe('still allowed', () => {
  const legit: Array<[string, Record<string, unknown>]> = [
    ['get_event_logs', {}],
    ['get_event_logs', { log_name: 'Application', max_events: 20, level: 'Error' }],
    ['get_event_logs', { log_name: 'System', level: 'Warning' }],
    ['get_event_logs', { log_name: 'Security', level: 'Information' }],
    ['get_event_logs_filtered', { log_name: 'Application', process_name: 'Application Error', event_id: 1000, hours_back: 24, level: 'Error', max_events: 50 }],
    ['get_event_logs_filtered', { log_name: 'System', process_name: 'Microsoft-Windows-Kernel-Power' }],
    ['get_event_logs_filtered', { log_name: 'Application', process_name: '.NET Runtime' }],
    ['get_event_logs_filtered', { log_name: 'Setup', process_name: 'Service Control Manager' }],
    ['manage_windows_feature', { type: 'optional_feature', action: 'install', name: 'NetFx3' }],
    ['manage_windows_feature', { type: 'optional_feature', action: 'remove', name: 'Microsoft-Hyper-V-All' }],
    ['manage_windows_feature', { type: 'capability', action: 'install', name: 'OpenSSH.Client~~~~0.0.1.0' }],
    ['manage_windows_feature', { type: 'capability', action: 'remove', name: 'Language.Basic~~~af-ZA~0.0.1.0' }],
    ['manage_windows_feature', { type: 'appx_package', action: 'remove', name: 'Microsoft.XboxGameBar', all_users: true }],
    ['manage_windows_feature', { type: 'appx_package', action: 'list', name_filter: 'Xbox*' }],
    ['manage_windows_feature', { type: 'optional_feature', action: 'list', name_filter: 'Open SSH' }],
    ['show_notification', { title: 'owlette', message: 'please wait: "restart" at 5pm & $5 <soon>', style: 'modal', duration_seconds: 10 }],
    ['get_service_status', { service_name: 'wuauserv' }],
    ['get_service_status', { service_name: 'Bonjour Service' }],
    ['get_service_status', { service_name: 'MSSQL$SQLEXPRESS' }],
    ['get_service_status', { service_name: 'getty@tty1.service' }],
    ['get_service_status', { service_name: 'com.apple.Finder' }],
    ['manage_windows_service', { service_name: 'OwletteService', action: 'set_recovery', first_failure: 'restart', restart_delay_ms: 60000, reset_counter_days: 1, reboot_message: "it's rebooting", run_program_path: 'C:\\Program Files\\a.exe' }],
    ['manage_scheduled_task', { action: 'list', name_filter: "it's \u201ca\u201d" }],
    ['manage_scheduled_task', { action: 'get_details', task_name: '\\Microsoft\\Windows\\UpdateOrchestrator\\Reboot' }],
    ['manage_scheduled_task', { action: 'create', task_name: 'weekly restart', description: 'it\'s "weekly"', trigger: { type: 'weekly', start_time: '04:00', days_of_week: ['mon', 'SUN'] }, task_action: { type: 'run_program', program: 'C:\\Program Files\\a.exe', arguments: '-File "C:\\x y\\z.ps1" -Name \'a\' $env:X', working_directory: "C:\\it's here" }, principal: { run_as: 'SYSTEM', run_level: 'highest' }, settings: { start_when_available: true, restart_count: 3, restart_interval_minutes: 1, multiple_instances: 'ignore_new' } }],
    ['manage_scheduled_task', { action: 'create', task_name: 't', trigger: { type: 'on_event', event_id: 101, log_name: 'Microsoft-Windows-TaskScheduler/Operational', source: 'Microsoft-Windows-TaskScheduler' }, task_action: { program: 'a.exe' } }],
    ['manage_scheduled_task', { action: 'create', task_name: 't', trigger: { type: 'logon', user: 'ACME\\kiosk user' }, task_action: { program: 'a.exe' } }],
    ['manage_scheduled_task', { action: 'create', task_name: 't', trigger: { type: 'once', start_datetime: '2030-01-31T14:00:00+02:00' }, task_action: { program: 'a.exe' } }],
    ['network_reset', { action: 'restart_adapter', adapter_name: 'Wi-Fi 2' }],
    ['manage_notifications', { action: 'disable_for_app', app_name: 'Microsoft.Windows.WindowsUpdate!App' }],
    ['registry_operation', { action: 'write', hive: 'HKLM', key_path: 'SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers', value_name: 'TdrDelay', value_data: '8', value_type: 'dword' }],
    ['manage_windows_update', { action: 'set_active_hours', start_hour: 8, end_hour: 17, override_active_hours: true, reason: 'venue closed' }],
    ['restart_process', { process_name: "Bob's Wall \u201cMain\u201d" }],
    ['set_launch_mode', { process_name: 'TD', mode: 'scheduled', schedules: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }] }],
    ['run_powershell', { script: "Get-Date\nWrite-Output 'x; y'", user_session: true }],
    ['run_command', { command: 'ipconfig /all' }],
    ['execute_script', { script: "'x'", timeout_seconds: 3300, working_directory: 'C:\\temp' }],
    ['read_file', { path: "C:\\ProgramData\\it's.txt" }],
    ['write_file', { path: 'C:\\temp\\a.txt', content: 'a\u0001b' }],
    ['capture_screenshot', { monitor: 0 }],
    ['reboot_machine', { when: 'after_active_hours' }],
    ['get_display_layout', {}],
    ['apply_display_topology', { layout: { monitors: [{ id: 'm' }] } }],
  ];

  it.each(legit)('%s %j', (tool, params) => {
    expect(toolParamRefusal(tool, params)).toBeNull();
  });
});

describe('a tool the server answers that hoot has not', () => {
  const definition: McpToolDefinition = {
    name: 'fleet_only',
    description: '',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '' },
        mode: { type: 'string', description: '', enum: ['a', 'b'] },
        on: { type: 'boolean', description: '' },
      },
      required: ['limit'],
    },
  };

  it('is unknown without its definition', () => {
    expect(toolParamRefusal('fleet_only', { limit: 5 })).toBe('unknown tool: fleet_only');
  });

  it('takes only the parameters it declares', () => {
    expect(toolParamRefusal('fleet_only', { limit: 5, extra: 1 }, definition)).toBe('fleet_only takes no parameter named extra');
  });

  it('checks its enums and booleans, and leaves the rest to its handler', () => {
    expect(toolParamRefusal('fleet_only', { limit: 'many' }, definition)).toBeNull();
    expect(toolParamRefusal('fleet_only', {}, definition)).toBeNull();
    expect(toolParamRefusal('fleet_only', { limit: 5, mode: 'c' }, definition)).toMatch(/^fleet_only: mode /);
    expect(toolParamRefusal('fleet_only', { limit: 5, on: 'yes' }, definition)).toMatch(/^fleet_only: on /);
  });

  it('a hoot tool keeps its own rules', () => {
    const hoot = allTools.find((tool) => tool.name === 'run_command')!;
    expect(toolParamRefusal('run_command', { command: 5 }, hoot)).toMatch(/^run_command: command /);
  });
});
