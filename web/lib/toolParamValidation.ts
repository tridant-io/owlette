/**
 * What each hoot tool may be called with, checked on the web before a call runs or
 * is queued, because the agents in the field take these values as they arrive.
 *
 * A definition in lib/mcp-tools.ts gives a tool's parameter names, what it requires,
 * its enums and its booleans. Every other parameter needs a rule here, and a test
 * fails until it has one. `checkedByItsHandler` is the rule for a tool that runs on
 * the web server, whose handler already validates that field and words the refusal.
 */
import { z } from 'zod';
import { allTools, type McpToolDefinition } from '@/lib/mcp-tools';

const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAK_OR_TAB = /[\t\n\r]/;
// older agents place these fields in a PowerShell string, whose tokenizer reads these
// as quotes. exit condition: the fleet floor is an agent that uses _ps_literal.
const SINGLE_QUOTE = /['‘’‚‛]/;
const TYPOGRAPHIC_DOUBLE_QUOTE = /[“”„]/;

const text = (max: number) =>
  z.string().max(max).refine((value) => !CONTROL_CHARACTER.test(value), 'must not hold a control character');

const line = (max: number) =>
  text(max).refine((value) => !LINE_BREAK_OR_TAB.test(value), 'must be a single line');

const noSingleQuote = (max: number) =>
  text(max).refine((value) => !SINGLE_QUOTE.test(value), "must not hold an apostrophe or single quote: rephrase without one");

const noDoubleQuoteForm = (schema: z.ZodString | ReturnType<typeof text>) =>
  schema.refine((value) => !TYPOGRAPHIC_DOUBLE_QUOTE.test(value), 'must use plain double quotes, not typographic ones');

const pattern = (regex: RegExp, says: string) => z.string().regex(regex, says);

const integer = (min: number, max: number) => z.number().int().min(min).max(max);

const checkedByItsHandler = z.unknown();

const SERVICE_NAME = pattern(
  /^[\p{L}\p{M}\p{N}_.][\p{L}\p{M}\p{N}_.\-]{0,255}$/u,
  'must be a service name: letters, digits and . _ - , not starting with -',
);
// windows names may hold a space or a $, and only this tool takes one: it asks the scm, not a shell.
const QUERIED_SERVICE_NAME = pattern(
  /^[\p{L}\p{M}\p{N}_.$][\p{L}\p{M}\p{N}_.@:$ \-]{0,255}$/u,
  'must be a service name: letters, digits, spaces and . _ @ : $ - , not starting with -',
);
const EVENT_PROVIDER = pattern(
  /^[\p{L}\p{M}\p{N}_ .()/+\-]{1,128}$/u,
  'must be an event provider name: letters, digits, spaces and . ( ) / + - _',
);
const EVENT_CHANNEL = pattern(
  /^[\p{L}\p{M}\p{N}_ .\-/]{1,128}$/u,
  'must be an event log name: letters, digits, spaces and . - / _',
);
// tighter than a provider name: older agents place this one outside any string, where
// a space or a bracket would be read as part of the script. same exit condition as above.
const TRIGGER_SOURCE = pattern(
  /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/,
  'must be one provider name: letters, digits and . _ - , no spaces',
);
const FEATURE_NAME = pattern(
  /^[A-Za-z0-9][A-Za-z0-9._~\-]{0,255}$/,
  'must be one feature name: letters, digits and . _ ~ - , no wildcards',
);
const FEATURE_FILTER = pattern(
  /^[A-Za-z0-9._~\-*? ]{0,128}$/,
  'must be letters, digits, spaces and . _ ~ - * ?',
);
const TASK_NAME = pattern(
  /^[\p{L}\p{M}\p{N}_.\\ \-]{1,256}$/u,
  'must be a task name: letters, digits, spaces and . _ - \\',
);
const TASK_TIME = pattern(
  /^[0-9A-Za-z:.+/\- ]{1,40}$/,
  'must be a date or time: letters, digits, spaces and : . + / -',
);
const TASK_USER = pattern(
  /^[\p{L}\p{M}\p{N}_ .\-\\@]{1,128}$/u,
  'must be a user name: letters, digits, spaces and . _ - \\ @',
);
const CLOCK = pattern(/^\d{1,2}:\d{2}$/, 'must be HH:MM');
const DAY = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

const LAUNCH_SCHEDULES = z.array(
  z.strictObject({
    days: z.array(DAY).max(7),
    ranges: z.array(z.strictObject({ start: CLOCK, stop: CLOCK })).max(50),
  }),
).max(50);

const TASK_TRIGGER = z.strictObject({
  type: z.enum(['boot', 'logon', 'once', 'daily', 'weekly', 'monthly', 'on_event', 'on_idle']),
  user: TASK_USER.optional(),
  start_datetime: TASK_TIME.optional(),
  start_time: TASK_TIME.optional(),
  days_interval: integer(1, 365).optional(),
  days_of_week: z.array(pattern(/^(mon|tue|wed|thu|fri|sat|sun)$/i, 'must be mon, tue, wed, thu, fri, sat or sun')).max(7).optional(),
  log_name: EVENT_CHANNEL.optional(),
  event_id: integer(0, 65535).optional(),
  source: TRIGGER_SOURCE.optional(),
  idle_minutes: integer(1, 1440).optional(),
});

const TASK_ACTION = z.strictObject({
  type: z.literal('run_program').optional(),
  program: noDoubleQuoteForm(line(1024)),
  arguments: noDoubleQuoteForm(line(4096)).optional(),
  working_directory: noDoubleQuoteForm(line(1024)).optional(),
});

const TASK_PRINCIPAL = z.strictObject({
  run_as: pattern(/^(SYSTEM|LOCAL_SERVICE|NETWORK_SERVICE|CURRENT_USER)$/i, 'must be SYSTEM, LOCAL_SERVICE, NETWORK_SERVICE or CURRENT_USER').optional(),
  run_level: pattern(/^(highest|limited)$/i, 'must be highest or limited').optional(),
});

const TASK_SETTINGS = z.strictObject({
  start_when_available: z.boolean().optional(),
  allow_start_on_batteries: z.boolean().optional(),
  stop_if_going_on_batteries: z.boolean().optional(),
  hidden: z.boolean().optional(),
  run_only_if_network_available: z.boolean().optional(),
  execution_time_limit_minutes: integer(1, 527040).optional(),
  restart_count: integer(1, 999).optional(),
  restart_interval_minutes: integer(1, 1440).optional(),
  multiple_instances: z.enum(['parallel', 'queue', 'ignore_new', 'stop_existing']).optional(),
  delete_expired_task_after_days: integer(1, 3650).optional(),
});

const PROCESS_NAME = line(256);
const FILE_PATH = line(4096);
const OVERRIDE_REASON = text(4000);

/** The fields of a tool whose whole payload its web-side handler validates. */
function allCheckedByItsHandler(...fields: string[]): Record<string, z.ZodType> {
  return Object.fromEntries(fields.map((field) => [field, checkedByItsHandler]));
}

const PROCESS_CONFIG = allCheckedByItsHandler(
  'name', 'exe_path', 'file_path', 'cwd', 'time_delay', 'time_to_init',
  'relaunch_attempts', 'schedules', 'schedulePresetId',
);

const RULES: Record<string, Record<string, z.ZodType>> = {
  get_site_logs: allCheckedByItsHandler('hours', 'limit', 'action'),
  get_running_processes: { name_filter: line(256), limit: integer(1, 200) },
  get_event_logs: { max_events: integer(1, 100) },
  get_service_status: { service_name: QUERIED_SERVICE_NAME },
  get_agent_logs: { max_lines: integer(1, 500) },
  get_system_presets: allCheckedByItsHandler('software_name', 'category'),
  schedule_followup: allCheckedByItsHandler('note', 'delay_minutes', 'at', 'watch_command_id'),
  cancel_followup: allCheckedByItsHandler('followup_id'),
  restart_process: { process_name: PROCESS_NAME },
  kill_process: { process_name: PROCESS_NAME },
  start_process: { process_name: PROCESS_NAME },
  set_launch_mode: { process_name: PROCESS_NAME, schedules: LAUNCH_SCHEDULES },
  update_process: { ...PROCESS_CONFIG, ...allCheckedByItsHandler('process_name') },
  add_process: PROCESS_CONFIG,
  delete_process: allCheckedByItsHandler('process_name'),
  capture_screenshot: { monitor: integer(0, 64) },
  manage_process: { name_pattern: line(256) },
  manage_windows_service: {
    service_name: SERVICE_NAME,
    restart_delay_ms: integer(0, 86_400_000),
    reset_counter_days: integer(0, 3650),
    reboot_message: line(512),
    run_program_path: line(1024),
  },
  configure_gpu_tdr: { timeout_seconds: integer(2, 300), ddi_timeout_seconds: integer(2, 300) },
  manage_windows_update: {
    pause_days: integer(1, 35),
    start_hour: integer(0, 23),
    end_hour: integer(0, 23),
    day_of_week: integer(0, 7),
    hour: integer(0, 23),
    days: integer(0, 365),
    reason: OVERRIDE_REASON,
  },
  manage_notifications: {
    app_name: pattern(/^[\p{L}\p{M}\p{N}_.!][\p{L}\p{M}\p{N}_.!\-]{0,255}$/u, 'must be an app id: letters, digits and . _ ! -'),
  },
  manage_scheduled_task: {
    task_name: TASK_NAME,
    name_filter: line(256),
    description: noDoubleQuoteForm(text(2000)),
    trigger: TASK_TRIGGER,
    task_action: TASK_ACTION,
    principal: TASK_PRINCIPAL,
    settings: TASK_SETTINGS,
  },
  network_reset: {
    adapter_name: pattern(/^[\p{L}\p{M}\p{N}_ .][\p{L}\p{M}\p{N}_ .\-]{0,255}$/u, 'must be an adapter name: letters, digits, spaces and . _ -'),
  },
  registry_operation: {
    key_path: pattern(/^[\x20-\x7e]{1,1024}$/, 'must be printable ascii'),
    value_name: line(256),
    value_data: z.union([text(65536), z.number(), z.array(text(4096)).max(256)]),
  },
  clean_disk_space: { older_than_days: integer(0, 3650) },
  get_event_logs_filtered: {
    process_name: EVENT_PROVIDER,
    event_id: integer(0, 65535),
    hours_back: integer(1, 168),
    max_events: integer(1, 200),
  },
  manage_windows_feature: { name: FEATURE_NAME, name_filter: FEATURE_FILTER },
  show_notification: { title: noSingleQuote(256), message: noSingleQuote(2000), duration_seconds: integer(1, 3600) },
  create_talon: allCheckedByItsHandler('name', 'description', 'trigger', 'condition', 'outputs', 'scope', 'cooldownMinutes', 'enabled'),
  set_talon_enabled: allCheckedByItsHandler('talon_id', 'enabled'),
  run_command: { command: text(32_000) },
  run_powershell: { script: text(500_000) },
  run_python: { code: text(500_000) },
  read_file: { path: FILE_PATH },
  write_file: { path: FILE_PATH, content: z.string().max(900_000) },
  list_directory: { path: FILE_PATH },
  execute_script: {
    script: text(500_000),
    timeout_seconds: z.number().positive(),
    working_directory: FILE_PATH,
  },
  deploy_software: {
    ...allCheckedByItsHandler(
      'software_name', 'version', 'preset_id', 'installer_url', 'installer_name',
      'silent_flags', 'close_processes', 'timeout_minutes',
    ),
    reason: OVERRIDE_REASON,
  },
  reboot_machine: { reason: OVERRIDE_REASON },
  shutdown_machine: { reason: OVERRIDE_REASON },
};

/** Tools the agent answers that hoot isn't offered, for the api callers that name them. */
const AGENT_ONLY_TOOLS: Record<string, z.ZodType> = {
  get_display_layout: z.strictObject({}),
  apply_display_topology: z.strictObject({ layout: z.looseObject({ monitors: z.array(z.unknown()) }) }),
};

type ToolProperty = { type: string | string[]; enum?: string[] };

/** The rule a definition's own fields already state, when they state one. */
function ruleFromDefinition(property: ToolProperty): z.ZodType | null {
  if (property.enum) return z.enum(property.enum as [string, ...string[]]);
  if (property.type === 'boolean') return z.boolean();
  return null;
}

function schemaOf(
  definition: McpToolDefinition,
  ruleFor: (name: string, property: ToolProperty) => z.ZodType,
): z.ZodType {
  const required = new Set(definition.parameters.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [name, property] of Object.entries(definition.parameters.properties)) {
    const rule = ruleFor(name, property);
    shape[name] = required.has(name) && rule !== checkedByItsHandler ? rule : rule.optional();
  }
  return z.strictObject(shape);
}

function buildSchemas(): Map<string, z.ZodType> {
  const schemas = new Map<string, z.ZodType>(Object.entries(AGENT_ONLY_TOOLS));
  for (const definition of allTools) {
    // a parameter with no rule refuses every value until it gets one.
    schemas.set(
      definition.name,
      schemaOf(definition, (name, property) => RULES[definition.name]?.[name] ?? ruleFromDefinition(property) ?? z.never()),
    );
  }
  return schemas;
}

let schemas: Map<string, z.ZodType> | undefined;

function schemaFor(toolName: string): z.ZodType | undefined {
  schemas ??= buildSchemas();
  return schemas.get(toolName);
}

/** Every `tool.parameter` with no rule, and every rule that names no such parameter. */
export function toolSchemaGaps(): string[] {
  const gaps: string[] = [];
  for (const definition of allTools) {
    const properties = definition.parameters.properties;
    for (const [name, property] of Object.entries(properties)) {
      if (!RULES[definition.name]?.[name] && !ruleFromDefinition(property)) {
        gaps.push(`${definition.name}.${name}`);
      }
    }
    for (const name of Object.keys(RULES[definition.name] ?? {})) {
      if (!(name in properties)) gaps.push(`${definition.name}.${name} (stale rule)`);
    }
  }
  const named = new Set(allTools.map((definition) => definition.name));
  for (const tool of Object.keys(RULES)) {
    if (!named.has(tool)) gaps.push(`${tool} (stale rule)`);
  }
  return gaps;
}

export function hasToolSchema(toolName: string): boolean {
  return schemaFor(toolName) !== undefined;
}

/**
 * Why this call must not run, in words for whoever made it, or null when it may. It
 * names the parameter and what it must be, and never repeats the value.
 *
 * `serverTool` is the definition of a tool the server answers that hoot doesn't have,
 * the fleet's own: it may take only the parameters it declares, its enums and booleans
 * are checked here, and its handler checks the rest, as the dashboard's routes do.
 */
export function toolParamRefusal(toolName: string, params: unknown, serverTool?: McpToolDefinition): string | null {
  const schema =
    schemaFor(toolName) ??
    (serverTool && schemaOf(serverTool, (_name, property) => ruleFromDefinition(property) ?? checkedByItsHandler));
  if (!schema) return `unknown tool: ${toolName}`;
  const parsed = schema.safeParse(params);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue.code === 'unrecognized_keys') {
    return `${toolName} takes no parameter named ${issue.keys.join(', ')}`;
  }
  const where = issue.path.join('.');
  return `${toolName}: ${where ? `${where} ` : ''}${issue.message}`;
}
