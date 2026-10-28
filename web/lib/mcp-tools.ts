/**
 * MCP tool definitions, shared by the chat API route (as model tool defs) and
 * the chat UI (for tool-call cards).
 *
 * Tier 1 read-only and tier 2 process management are auto-approved; tier 3 is
 * privileged and requires in-chat user confirmation, as does any call that
 * overrides active hours.
 */

export type ToolTier = 1 | 2 | 3;

export interface McpToolDefinition {
  name: string;
  description: string;
  tier: ToolTier;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string | string[];
      description: string;
      enum?: string[];
      default?: unknown;
      items?: unknown;
    }>;
    required?: string[];
  };
}

/**
 * The active-hours override pair. A call that sets it waits for a person's
 * approval in a dashboard chat (hoot-utils.server.ts); a turn no person drives,
 * autonomous hoot included, is never offered it.
 */
export const ACTIVE_HOURS_OVERRIDE_PARAMS = ['override_active_hours', 'reason'] as const;

function activeHoursOverrideFields(override: string): McpToolDefinition['parameters']['properties'] {
  return {
    override_active_hours: {
      type: 'boolean',
      description: `${override} Set it only when the operator explicitly asked for that and gave a reason. The call then waits for their approval in this chat, and works on one machine at a time. It only matters on Windows machines running owlette 4.1.21 or later; older agents ignore it.`,
    },
    reason: {
      type: 'string',
      description: "Required with override_active_hours: the operator's reason, 500 characters or fewer. The machine logs it with who approved it.",
    },
  };
}

export function takesActiveHoursOverride(def: McpToolDefinition): boolean {
  return 'override_active_hours' in def.parameters.properties;
}

/** The definition without the override pair, for callers no person approves. */
export function withoutActiveHoursOverride(def: McpToolDefinition): McpToolDefinition {
  if (!takesActiveHoursOverride(def)) return def;
  const properties = { ...def.parameters.properties };
  for (const name of ACTIVE_HOURS_OVERRIDE_PARAMS) delete properties[name];
  return { ...def, parameters: { ...def.parameters, properties } };
}

// Tier 1: Read-Only Tools

const tier1Tools: McpToolDefinition[] = [
  {
    name: 'get_site_logs',
    description: 'Get activity logs across all machines in the site. Useful for finding errors, crashes, and events across the fleet.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          description: 'Filter by log level (optional).',
          enum: ['error', 'warning', 'info'],
        },
        hours: {
          type: 'number',
          description: 'Look back this many hours (default: 24).',
          default: 24,
        },
        limit: {
          type: 'number',
          description: 'Maximum number of logs to return (default: 50).',
          default: 50,
        },
        action: {
          type: 'string',
          description: 'Filter by action type, e.g. process_crash, agent_started (optional).',
        },
      },
    },
  },
  {
    name: 'get_system_info',
    description: 'Get comprehensive system information: hostname, OS (with correct Windows 10/11 detection), CPU model and usage, memory (used/total GB), disk (used/total GB), GPU model, GPU driver version, VRAM (used/total GB), GPU load %, system uptime, and agent version. Use this as the first step for any hardware or system questions.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_process_list',
    description: 'Get all Owlette-configured processes with their current status, PID, launch mode, executable path (exe_path), file path / command arguments (file_path), working directory (cwd), and whether they are running.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_running_processes',
    description: 'Get all running OS processes with CPU and memory usage. Can filter by name. Returns top processes sorted by memory usage.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        name_filter: {
          type: 'string',
          description: 'Optional filter — only return processes whose name contains this string (case-insensitive).',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of processes to return (default: 50, max: 200).',
          default: 50,
        },
      },
    },
  },
  {
    name: 'get_gpu_processes',
    description: 'Get per-process GPU memory (VRAM) usage via Windows Performance Counters (same data source as Task Manager). Shows dedicated and shared GPU memory per process, sorted by usage. Works cross-vendor (NVIDIA, AMD, Intel) and for all GPU APIs (DirectX, OpenGL, CUDA, Vulkan). Use this when asked about VRAM usage, GPU memory, or which process is using the most GPU memory.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_network_info',
    description: 'Get network interfaces with IP addresses, netmasks, and link status.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_disk_usage',
    description: 'Get disk usage for all drives including total, used, free space and percentage.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_event_logs',
    description: 'Get Windows event log entries from Application, System, or Security logs. Can filter by severity level.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        log_name: {
          type: 'string',
          description: 'Which event log to query.',
          enum: ['Application', 'System', 'Security'],
          default: 'Application',
        },
        max_events: {
          type: 'number',
          description: 'Maximum number of events to return (default: 20, max: 100).',
          default: 20,
        },
        level: {
          type: 'string',
          description: 'Filter by severity level.',
          enum: ['Error', 'Warning', 'Information'],
        },
      },
    },
  },
  {
    name: 'get_service_status',
    description: 'Get the status and start type of a Windows service. IMPORTANT: Many Windows services (e.g., wuauserv/Windows Update, BITS) are demand-start — they start when needed and stop when idle. For these services, "stopped" is the normal idle state and does NOT mean disabled. Check the returned start_type field: "demand_start" means stopped-is-normal, "disabled" means truly off, "automatic" means should be running.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        service_name: {
          type: 'string',
          description: 'The Windows service name to query.',
        },
      },
      required: ['service_name'],
    },
  },
  {
    name: 'get_agent_config',
    description: 'Get the current Owlette agent configuration (sensitive fields like tokens are stripped).',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_agent_logs',
    description: 'Get recent Owlette agent log entries. Can filter by log level (ERROR, WARNING, INFO, DEBUG).',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        max_lines: {
          type: 'number',
          description: 'Maximum number of log lines to return (default: 100, max: 500).',
          default: 100,
        },
        level: {
          type: 'string',
          description: 'Filter by log level.',
          enum: ['ERROR', 'WARNING', 'INFO', 'DEBUG'],
        },
      },
    },
  },
  {
    name: 'get_agent_health',
    description: 'Get agent health status including connection state and health probe results.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_system_presets',
    description: 'Get available software deployment presets managed by the site admin. Returns installer URLs, silent install flags, verification paths, and other deployment parameters for software like TouchDesigner, Unreal Engine, media players, etc. Use this BEFORE deploy_software to find the correct preset and parameters for a software package.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        software_name: {
          type: 'string',
          description: 'Filter presets by software name (case-insensitive partial match). E.g. "TouchDesigner", "Unreal".',
        },
        category: {
          type: 'string',
          description: 'Filter by category. E.g. "Creative Software", "Media Server", "Utilities".',
        },
      },
    },
  },
  {
    name: 'check_pending_reboot',
    description: 'Diagnostic: detect whether a system reboot is currently pending (from Windows Update, Component Based Servicing, or SCCM client). Read-only. Returns pending (bool), reasons (array), file_renames (bool), last update install time, and next scheduled update run time if available. file_renames means file renames are queued for the next boot; installers and drivers leave those for weeks, so they do not count as pending and are not a Windows Update restart. Use during incident investigations, after a suspected update, or when the machine is behaving unusually.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  // Scheduled follow-ups — chat records executed by the cron sweep, never relayed
  // to a machine. They are how a promise to "check back later" actually happens.
  {
    name: 'schedule_followup',
    description: 'Schedule a follow-up turn on this conversation. At the scheduled time you are re-opened in this same chat with `note` as the instruction, and you act on it and report back. Use this instead of saying you will keep watching something — this turn ends when you stop typing, so nothing else will check. Typical uses: read an install log after a detached job, re-check a metric after a restart, confirm a machine came back online. Pass EXACTLY ONE of delay_minutes (1 to 10080 — one minute to seven days) or at (an absolute ISO 8601 timestamp, in the future and no more than seven days out); passing both, or neither, is an error you must correct. Write `note` as a self-contained instruction to your future self: it arrives without this conversation in view, so name the machine, the path, the process, and what a good result looks like. Returns followup_id and fires_at (ISO) — keep followup_id in case you need cancel_followup.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'What the follow-up turn should do, written as a complete instruction to yourself with no context assumed. 1000 characters or fewer.',
        },
        delay_minutes: {
          type: 'number',
          description: 'Fire this many minutes from now: 1 to 10080 (one minute to seven days). Mutually exclusive with `at` — pass exactly one of the two.',
        },
        at: {
          type: 'string',
          description: 'Fire at this absolute time, as an ISO 8601 timestamp WITH a timezone offset (e.g. "2026-01-31T14:00:00Z"). Must be in the future and within seven days. Mutually exclusive with `delay_minutes` — pass exactly one of the two.',
        },
        watch_command_id: {
          type: 'string',
          description: 'Optional id of a machine command already dispatched in this conversation. The follow-up then fires as soon as that command finishes, or at its scheduled time, whichever comes first — the schedule stays the backstop. Only pass an id you actually hold; it is ignored for site-wide chats, which have no single command to watch.',
        },
      },
      required: ['note'],
    },
  },
  {
    name: 'cancel_followup',
    description: 'Cancel a scheduled follow-up before it fires, using the followup_id returned by schedule_followup. Use it when the thing the follow-up was going to check has already been settled in this conversation, or when the operator asks you to drop it. Only the user who scheduled a follow-up can cancel it, and only while it is still pending — one that has already fired or been cancelled cannot be undone.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        followup_id: {
          type: 'string',
          description: 'The follow-up id returned by schedule_followup. Never guess one.',
        },
      },
      required: ['followup_id'],
    },
  },
  // Read-only: any site member can already read the site's talons.
  {
    name: 'list_talons',
    description: 'List the talons on this site: id, name, whether it is enabled, its trigger, its output types, and how its last run went. Call this before set_talon_enabled to get the talon id, and before create_talon so you do not duplicate a talon that already exists.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

// Tier 2: Process Management

const processScheduleBlocksSchema = {
  type: 'object',
  properties: {
    days: {
      type: 'array',
      items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
      description: 'Days this block applies to.',
    },
    ranges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'string', description: 'Start time in HH:MM format.' },
          stop: { type: 'string', description: 'Stop time in HH:MM format.' },
        },
        required: ['start', 'stop'],
      },
      description: 'Time windows within those days.',
    },
  },
  required: ['days', 'ranges'],
};

const processConfigFields: McpToolDefinition['parameters']['properties'] = {
  name: {
    type: 'string',
    description: 'Display name for the process.',
  },
  exe_path: {
    type: 'string',
    description: 'Full path to the executable.',
  },
  file_path: {
    type: 'string',
    description: 'Project file path or command arguments passed to the executable.',
  },
  cwd: {
    type: 'string',
    description: 'Working directory for the process.',
  },
  priority: {
    type: 'string',
    enum: ['Low', 'Normal', 'High', 'Realtime'],
    description: 'Process priority.',
  },
  visibility: {
    type: 'string',
    enum: ['Normal', 'Hidden'],
    description: 'Window visibility.',
  },
  time_delay: {
    type: 'string',
    description: 'Launch delay in seconds, stored as a string.',
  },
  time_to_init: {
    type: 'string',
    description: 'Initialization timeout in seconds, stored as a string.',
  },
  relaunch_attempts: {
    type: 'string',
    description: 'Number of crash relaunch attempts, stored as a string.',
  },
  launch_mode: {
    type: 'string',
    enum: ['off', 'always', 'scheduled'],
    description: 'Launch management mode: "off", "always", or "scheduled".',
  },
  schedules: {
    type: 'array',
    description: 'Schedule blocks for scheduled mode. Each block has days and time ranges.',
    items: processScheduleBlocksSchema,
  },
  schedulePresetId: {
    type: ['string', 'null'],
    description: 'Named schedule preset id, or null to clear.',
  },
};

/**
 * One entry of a talon's `outputs` array, as JSON Schema. Field names are the
 * talon WIRE names — this goes straight to `validateTalonInput`, which rejects
 * unknown top-level fields, so schema and validator must agree exactly.
 * Declared out here because `McpToolDefinition` types `items` as `unknown`.
 */
const talonOutputItemSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      enum: ['email', 'webhook', 'cortex', 'command'],
      description: 'email = notify the site alert recipients; webhook = POST the run payload; cortex = hand a directive to hoot (the wire value stays "cortex"); command = queue process control on the machines in scope.',
    },
    url: {
      type: 'string',
      description: 'webhook outputs only — an https URL. Private, loopback, and link-local addresses are rejected.',
    },
    directive: {
      type: 'string',
      description: 'hoot outputs (type "cortex") only — what hoot should do when the talon fires, 1000 characters or fewer.',
    },
    commandType: {
      type: 'string',
      enum: ['restart_process', 'start_process', 'stop_process'],
      description: 'command outputs only — which process command to queue.',
    },
    processName: {
      type: 'string',
      description: 'command outputs only — the configured process name to act on.',
    },
    processId: {
      type: 'string',
      description: 'command outputs only — the configured process id, when you already have it.',
    },
  },
  required: ['type'],
};

const tier2Tools: McpToolDefinition[] = [
  {
    name: 'restart_process',
    description: 'Restart an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to restart (must be configured in Owlette).',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'kill_process',
    description: 'Kill/stop an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to kill.',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'start_process',
    description: 'Start an Owlette-configured process by name.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to start.',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'set_launch_mode',
    description: 'Set the launch mode for an Owlette-configured process. Modes: "off" (not managed), "always" (24/7 with crash recovery), "scheduled" (runs during configured time windows only). When setting to "scheduled", also provide a schedules array with day/time blocks.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The name of the process to set launch mode for.',
        },
        mode: {
          type: 'string',
          enum: ['off', 'always', 'scheduled'],
          description: 'The launch mode: "off", "always", or "scheduled".',
        },
        schedules: {
          type: 'array',
          description: 'Schedule blocks (required when mode is "scheduled"). Each block has days and time ranges.',
          items: {
            type: 'object',
            properties: {
              days: {
                type: 'array',
                items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
                description: 'Days this block applies to.',
              },
              ranges: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    start: { type: 'string', description: 'Start time in HH:MM format.' },
                    stop: { type: 'string', description: 'Stop time in HH:MM format.' },
                  },
                  required: ['start', 'stop'],
                },
                description: 'Time windows within those days.',
              },
            },
            required: ['days', 'ranges'],
          },
        },
      },
      required: ['process_name', 'mode'],
    },
  },
  {
    name: 'update_process',
    description: 'Update an Owlette-configured process\'s configuration fields. Accepts a partial set of fields to change - only fields you provide are updated; others are left unchanged. Available fields: name (display name), exe_path (full path to the executable), file_path (project file or command arguments), cwd (working directory, optional), priority (\'Low\' | \'Normal\' | \'High\' | \'Realtime\'), visibility (\'Normal\' | \'Hidden\'), time_delay (launch delay seconds), time_to_init (init timeout seconds), relaunch_attempts (number of crash relaunches), launch_mode (\'off\' | \'always\' | \'scheduled\'), schedules (array of {days, ranges} blocks for scheduled mode), schedulePresetId (named preset id, or null to clear). Use this when the user asks to rename a process, fix a stale path, change priority/visibility, tune timing, or adjust the schedule.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The current configured process name to update.',
        },
        ...processConfigFields,
      },
      required: ['process_name'],
    },
  },
  {
    name: 'add_process',
    description: 'Create a new Owlette-managed process on a machine. Required fields: name, exe_path. Optional fields: file_path, cwd, priority, visibility, time_delay, time_to_init, relaunch_attempts, launch_mode, schedules, schedulePresetId. The new process is added with launch_mode=\'off\' by default; set explicitly to \'always\' or \'scheduled\' to enable management.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: processConfigFields,
      required: ['name', 'exe_path'],
    },
  },
  {
    name: 'delete_process',
    description: 'Delete an Owlette-configured process by name. The process is removed from the machine\'s config. If the process is currently running, it remains running (the agent stops managing it but does not terminate). Use kill_process first if you want to actually stop the running process.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        process_name: {
          type: 'string',
          description: 'The configured process name to delete.',
        },
      },
      required: ['process_name'],
    },
  },
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the remote machine\'s desktop. Returns the captured image for you to analyze visually — use this to see what is actually on screen. Use when the operator reports visual issues (frozen screen, black screen, wrong content, display glitches), asks what is currently on screen, or after restarting a display/media process to verify visual recovery. Do not capture screenshots for pure backend or service issues where the display is irrelevant. Use monitor=0 for all displays combined, or monitor=1, 2, etc. for a specific display.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        monitor: {
          type: 'number',
          description: 'Monitor index: 0 = all monitors combined (default), 1 = primary display, 2 = second display, etc.',
          default: 0,
        },
      },
    },
  },
  {
    name: 'manage_process',
    description: 'Kill, suspend, or resume OS processes by name pattern. Works on ANY process, not just Owlette-managed ones. Safer than run_command + taskkill: validated params, no shell, refuses to touch critical system processes (lsass, winlogon, csrss, etc.). Use when you need to terminate hung apps, free up VRAM/memory by killing a runaway process, or stop a non-Owlette app that is interfering with the kiosk.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        name_pattern: {
          type: 'string',
          description: 'Process name (with .exe) or glob pattern. Examples: "chrome.exe", "FreeFileSync*", "notepad*".',
        },
        action: {
          type: 'string',
          enum: ['kill', 'suspend', 'resume'],
          description: 'kill = terminate, suspend = pause execution, resume = continue a suspended process.',
        },
        match_exact: {
          type: 'boolean',
          description: 'If true (default), exact name match. If false, glob pattern matching via fnmatch.',
          default: true,
        },
        force: {
          type: 'boolean',
          description: 'For kill action: force-kill immediately if true (default), otherwise try graceful termination first.',
          default: true,
        },
      },
      required: ['name_pattern', 'action'],
    },
  },
  {
    name: 'manage_windows_service',
    description: 'Full services.msc parity — start, stop, restart, pause/continue, set startup type, configure failure recovery, or get full service details. Use set_recovery to configure auto-restart on crash (critical for unattended media installations). Use get_details to query everything about a service in one call: status, startup type, binary path, dependencies, recovery config.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        service_name: {
          type: 'string',
          description: 'Name of the Windows service (not the display name).',
        },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'restart', 'pause', 'continue', 'set_startup', 'set_recovery', 'get_details'],
          description: 'State ops (start/stop/restart/pause/continue), configuration (set_startup, set_recovery), or query (get_details).',
        },
        startup_type: {
          type: 'string',
          enum: ['auto', 'auto_delayed', 'manual', 'disabled'],
          description: 'For set_startup: the new startup type.',
        },
        first_failure: {
          type: 'string',
          enum: ['restart', 'run_program', 'reboot', 'none'],
          description: 'For set_recovery: action on first failure.',
        },
        second_failure: {
          type: 'string',
          enum: ['restart', 'run_program', 'reboot', 'none'],
          description: 'For set_recovery: action on second failure.',
        },
        subsequent_failures: {
          type: 'string',
          enum: ['restart', 'run_program', 'reboot', 'none'],
          description: 'For set_recovery: action on third and subsequent failures.',
        },
        restart_delay_ms: {
          type: 'number',
          description: 'For set_recovery: delay between failure and action in milliseconds. Default 60000 (1 min).',
          default: 60000,
        },
        reset_counter_days: {
          type: 'number',
          description: 'For set_recovery: reset failure count after this many days of no failures. Default 1.',
          default: 1,
        },
        reboot_message: {
          type: 'string',
          description: 'For set_recovery: optional broadcast message if action is reboot.',
        },
        run_program_path: {
          type: 'string',
          description: 'For set_recovery: path to program to run on failure (required if any action is run_program).',
        },
      },
      required: ['service_name', 'action'],
    },
  },
  {
    name: 'configure_gpu_tdr',
    description: 'Configure Windows GPU Timeout Detection and Recovery. Writes TdrDelay (and optionally TdrDdiDelay) to the registry. Critical for TouchDesigner/Unreal/Unity installations with heavy shader work — the default 2-second timeout causes silent crashes on complex GPU operations. A reboot is required for changes to take effect.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        timeout_seconds: {
          type: 'number',
          description: 'TdrDelay value in seconds (2-300). Windows default is 2; heavy creative workloads usually need 10-60.',
        },
        ddi_timeout_seconds: {
          type: 'number',
          description: 'Optional TdrDdiDelay value in seconds (2-300). Maximum time the GPU can spend in Present/Draw calls.',
        },
      },
      required: ['timeout_seconds'],
    },
  },
  {
    name: 'manage_windows_update',
    description: "Read and change how Windows Update installs updates and restarts the machine. Windows Update is the #1 threat to unattended 24/7 installations. get_status reports the machine's active hours and whether it is inside them now, the install and restart settings, any update deadline, the pause state, and whether a Windows Update restart is pending. Active hours hold Windows' own update restarts only until an update deadline passes, and owlette 4.1.21 or later refuses reboots, shutdowns and deployments inside them. To stop Windows restarting on its own, use limit_auto_restart: it sets active hours and removes restart deadlines, so Windows restarts for updates only outside active hours; a nightly restart can still happen. Use disable_auto_install only when the operator wants no update restarts at all: it stops automatic installs and so update restarts, but security updates then wait for a person to install them; enable_auto_install undoes it. limit_auto_restart, disable_auto_install and enable_auto_install need owlette 4.1.21 or later. set_scheduled_install turns on scheduled install: updates install at that time and Windows restarts the machine then to finish them. pause holds updates for up to 35 days, for example before a live event, and resume ends a pause. set_feature_deferral / set_quality_deferral delay update rollouts.",
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'get_status',
            'pause',
            'resume',
            'set_active_hours',
            'limit_auto_restart',
            'disable_auto_install',
            'enable_auto_install',
            'set_scheduled_install',
            'set_feature_deferral',
            'set_quality_deferral',
          ],
          description: 'The Windows Update operation to perform.',
        },
        pause_days: {
          type: 'number',
          description: 'For pause: number of days to pause updates (1-35).',
        },
        start_hour: {
          type: 'number',
          description: 'For set_active_hours, or optionally limit_auto_restart (default: the current active hours): the hour active hours start (0-23).',
        },
        end_hour: {
          type: 'number',
          description: 'For set_active_hours, or optionally limit_auto_restart: the hour active hours end (0-23); 17 means until 17:00. At most 18 hours after start_hour.',
        },
        day_of_week: {
          type: 'number',
          description: 'For set_scheduled_install: day of week (0=every day, 1=Sunday, 2=Monday, ..., 7=Saturday).',
        },
        hour: {
          type: 'number',
          description: 'For set_scheduled_install: hour of day to install (0-23). Windows restarts the machine then to finish.',
        },
        days: {
          type: 'number',
          description: 'For set_feature_deferral (0-365) or set_quality_deferral (0-30): deferral days.',
        },
        ...activeHoursOverrideFields(
          'For set_active_hours or limit_auto_restart: allow new active hours that leave the machine outside them right now, which is refused without it.',
        ),
      },
      required: ['action'],
    },
  },
  {
    name: 'suppress_setup_screens',
    description: 'Suppress the full-screen Windows setup screens that hijack the display at sign-in after updates: the "Choose privacy settings" experience, the Windows Welcome Experience ("Hi! We\'ve got some updates"), "Let\'s finish setting up your device" (SCOOBE), and the Edge first-run tour. Covers every existing user profile (mounting signed-out profiles\' hives) plus the Default profile so future accounts inherit the suppression. apply is idempotent and safe to re-run — feature updates are known to reset these keys, so re-assert on a schedule. get_status reports per-profile drift without writing anything.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_status', 'apply'],
          description: 'get_status: read-only drift report per profile. apply: write all suppression keys machine-wide and for every user profile.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'manage_notifications',
    description: 'Control Windows toast notifications and Focus Assist. Essential for kiosks and video walls where a surprise "Updates are ready" or "Teams call" toast would appear on the display during an exhibit. Use disable_all_toasts to fully silence the system, enable_focus_assist with alarms_only for total silence, or disable_for_app to silence a specific app.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get_status', 'disable_all_toasts', 'enable_focus_assist', 'disable_focus_assist', 'disable_for_app'],
          description: 'The notification management operation.',
        },
        app_name: {
          type: 'string',
          description: 'For disable_for_app: the app identifier (e.g. "Microsoft.WindowsStore", "MSTeams", "Microsoft.Windows.WindowsUpdate").',
        },
        focus_mode: {
          type: 'string',
          enum: ['priority_only', 'alarms_only'],
          description: 'For enable_focus_assist: priority_only allows priority senders, alarms_only silences everything except alarms.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'configure_power_plan',
    description: 'Set Windows power plan and disable sleep/hibernate/screen blanking. Required for any 24/7 unattended installation — default power settings will sleep the machine, blank the screen, or hibernate, all of which break live deployments. Use plan="high_performance" for media work, and enable disable_sleep + disable_hibernate + disable_screen_blanking together for kiosk setups.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          enum: ['high_performance', 'balanced', 'ultimate_performance'],
          description: 'Power plan to activate (optional — omit to keep current plan).',
        },
        disable_sleep: {
          type: 'boolean',
          description: 'Disable standby/sleep timeout (sets to Never on both AC and battery).',
        },
        disable_hibernate: {
          type: 'boolean',
          description: 'Disable hibernation entirely (removes hiberfil.sys).',
        },
        disable_screen_blanking: {
          type: 'boolean',
          description: 'Disable monitor timeout (prevents screen blanking).',
        },
      },
    },
  },
  {
    name: 'manage_scheduled_task',
    description: 'Full Task Scheduler parity — list, enable, disable, delete, run_now, stop, create new tasks, get details, and get run history. Use create to schedule weekly memory-flush reboots, hourly health checks, boot-time media app launches, or event-triggered restarts. Specify the trigger (boot/daily/weekly/once/on_event/on_logon/on_idle), the action (run_program), the principal (SYSTEM/LOCAL_SERVICE/etc.), and settings (retry count, execution time limit, etc.).',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'enable', 'disable', 'delete', 'run_now', 'stop', 'create', 'get_details', 'get_history'],
          description: 'The operation to perform.',
        },
        task_name: {
          type: 'string',
          description: 'Name of the task (required for all non-list actions). Can include folder path like "\\Folder\\TaskName".',
        },
        name_filter: {
          type: 'string',
          description: 'For list: substring filter on task name.',
        },
        description: {
          type: 'string',
          description: 'For create: optional human-readable description.',
        },
        trigger: {
          type: 'object',
          description: 'For create: trigger definition. type is one of boot/logon/once/daily/weekly/on_event/on_idle. Additional fields depend on type (e.g. daily needs start_time, weekly needs days_of_week + start_time, on_event needs log_name + event_id).',
        },
        task_action: {
          type: 'object',
          description: 'For create: {type: "run_program", program: path, arguments?: str, working_directory?: str}. NOTE: this is the task\'s action, distinct from the top-level action parameter.',
        },
        principal: {
          type: 'object',
          description: 'For create: {run_as: SYSTEM|LOCAL_SERVICE|NETWORK_SERVICE|current_user, run_level: highest|limited}.',
        },
        settings: {
          type: 'object',
          description: 'For create: {start_when_available, execution_time_limit_minutes, restart_count, restart_interval_minutes, run_only_if_network_available, allow_start_on_batteries, hidden, multiple_instances, delete_expired_task_after_days}.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'network_reset',
    description: 'Flush DNS, renew IP lease, restart network adapter, or reset the winsock stack. Common fix for NDI dropouts, Firebase connectivity loss, DNS resolution issues at venue networks. reset_winsock requires a reboot to fully take effect.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['flush_dns', 'renew_ip', 'restart_adapter', 'reset_winsock'],
          description: 'The network operation to perform.',
        },
        adapter_name: {
          type: 'string',
          description: 'For restart_adapter: name of the network adapter (e.g. "Ethernet", "Wi-Fi").',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'registry_operation',
    description: 'Read, write, or delete Windows registry values. Restricted to an allowlist of safe registry paths (Winlogon, GraphicsDrivers, WindowsUpdate, Notifications, Power, Services, etc.) — system hives like SAM, SECURITY, and Cryptography are blocked. On owlette 4.1.21 or later it refuses to write or delete the active hours values; change those with manage_windows_update set_active_hours or limit_auto_restart. Use this for structured registry edits instead of execute_script + reg.exe.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write', 'delete'],
          description: 'Registry operation.',
        },
        hive: {
          type: 'string',
          enum: ['HKLM', 'HKCU'],
          description: 'Registry hive: HKLM (machine) or HKCU (current user).',
        },
        key_path: {
          type: 'string',
          description: 'Key path under the hive, e.g. "SYSTEM\\\\CurrentControlSet\\\\Control\\\\GraphicsDrivers". Must match an allowed prefix.',
        },
        value_name: {
          type: 'string',
          description: 'Value name (required for write/delete; omit for read to enumerate all values in the key).',
        },
        value_data: {
          type: 'string',
          description: 'For write: the data to write. For dword, pass as a string like "8"; for binary, pass as hex string; for string types, just the text.',
        },
        value_type: {
          type: 'string',
          enum: ['string', 'dword', 'binary', 'expand_string', 'multi_string'],
          description: 'For write: registry value type.',
        },
      },
      required: ['action', 'hive', 'key_path'],
    },
  },
  {
    name: 'clean_disk_space',
    description: 'Clean temp files, windows temp, prefetch cache, recycle bin, or Owlette logs with age filter. Use dry_run=true to preview what would be deleted before committing. Essential when media rendering caches fill up disks and cause process failures.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['temp', 'windows_temp', 'prefetch', 'recycle_bin', 'owlette_logs'],
          description: 'Which location to clean.',
        },
        older_than_days: {
          type: 'number',
          description: 'Only delete files older than N days (default 7). Ignored for recycle_bin.',
          default: 7,
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, return counts and sizes without actually deleting.',
          default: false,
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'get_event_logs_filtered',
    description: 'Fast filtered event log query via Get-WinEvent -FilterHashtable. Orders of magnitude faster than the general get_event_logs when you need events from a specific process, event ID, or time window. Use this instead of get_event_logs when searching for specific crashes or errors.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        log_name: {
          type: 'string',
          enum: ['Application', 'System', 'Security', 'Setup'],
          description: 'Event log to query.',
        },
        process_name: {
          type: 'string',
          description: 'Optional: filter by provider/source name.',
        },
        event_id: {
          type: 'number',
          description: 'Optional: specific event ID (e.g. 41 for unexpected shutdown, 1000 for app crash).',
        },
        hours_back: {
          type: 'number',
          description: 'Look back this many hours (1-168).',
          default: 24,
        },
        level: {
          type: 'string',
          enum: ['Critical', 'Error', 'Warning', 'Information', 'Verbose'],
          description: 'Optional: filter by severity level.',
        },
        max_events: {
          type: 'number',
          description: 'Maximum events to return (1-200).',
          default: 50,
        },
      },
      required: ['log_name'],
    },
  },
  {
    name: 'manage_windows_feature',
    description: 'Add, remove, or list Windows Optional Features (DISM, e.g. NetFx3, OpenSSH-Server), Windows Capabilities (FoD, e.g. OpenSSH.Client), or AppX Packages (Microsoft Store apps like OneDrive, Xbox Game Bar, Cortana, Teams). Use for kiosk provisioning — removing OneDrive/Xbox/Cortana bloat and installing needed features. Critical features for Owlette itself are blocklisted and cannot be disabled.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['optional_feature', 'capability', 'appx_package'],
          description: 'Category of feature.',
        },
        action: {
          type: 'string',
          enum: ['list', 'install', 'remove'],
          description: 'Operation to perform. AppX install is not supported.',
        },
        name: {
          type: 'string',
          description: 'For install/remove: feature/capability/package name (e.g. NetFx3, OpenSSH.Client~~~~0.0.1.0, Microsoft.XboxGameBar).',
        },
        all_users: {
          type: 'boolean',
          description: 'For appx_package remove: also remove the provisioning package so new user profiles do not get it reinstalled.',
          default: false,
        },
        name_filter: {
          type: 'string',
          description: 'For list: substring filter on name.',
        },
      },
      required: ['type', 'action'],
    },
  },
  {
    name: 'show_notification',
    description: 'Display an on-screen message on the remote machine — useful when a technician is physically nearby (live events, setup, maintenance). Toast style is a subtle corner notification; modal style uses msg.exe to display a message box that blocks the screen briefly. Opposite of manage_notifications, which suppresses notifications.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Notification title.',
        },
        message: {
          type: 'string',
          description: 'Notification body / message.',
        },
        style: {
          type: 'string',
          enum: ['toast', 'modal'],
          description: 'toast = subtle corner notification (default), modal = blocking message box via msg.exe.',
          default: 'toast',
        },
        duration_seconds: {
          type: 'number',
          description: 'For modal style: how long the message box stays up (default 5).',
          default: 5,
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'create_talon',
    description: `Create a talon on this site. A talon is a saved automation: a trigger fires, an optional condition gates it, and one or more outputs run.

CRITICAL — CONFIRM BEFORE CALLING:
Never call this from a vague request. First state back the exact talon you intend to create — trigger, condition, every output, which machines it covers, and the cooldown — and wait for the operator to confirm. A talon runs unattended against real machines; do not guess any part of it.

TRIGGER (exactly one form):
- clock times: {"type":"schedule","entries":[{"id":"e1","days":["mon","wed"],"time":"09:00"}]} — 24-hour HH:MM in the site's timezone, up to 50 entries.
- interval: {"type":"schedule","intervalMinutes":30} — 5 to 1440 minutes, but 15 minutes minimum when the condition is a visual_check. "entries" and "intervalMinutes" are mutually exclusive.
- threshold: {"type":"threshold","metric":"cpu_percent","operator":">","value":90} — metrics: cpu_percent, memory_percent, disk_percent, gpu_percent, cpu_temp, gpu_temp, network_latency, network_packet_loss. Operators: >, <, >=, <=.
- event: {"type":"event","eventTypes":["process_crash","machine_offline"]} — also process_start_failed, process_restarted, exe_missing, and the display_* events (display_monitor_removed, display_apply_failed, display_drift, ...). Event triggers only, add "delayMinutes":N (0-1440) to wait N minutes after the event before running — e.g. let a restarted app finish booting before a visual_check looks at it. Omit it, or use 0, to run the moment the event lands.

CONDITION (optional, defaults to {"type":"none"}):
- {"type":"visual_check","expectation":"the lobby wall is playing the loop, not showing a desktop","monitor":0} — captures a fresh screenshot and asks a vision model whether the expectation holds. monitor 0 = all displays combined, 1 = primary. Needs the talon author to have an LLM key saved.

OUTPUTS (1 to 5, run in order): email (notify the site's alert recipients), webhook (POST the run payload to an https URL), cortex (hand a directive to hoot to carry out — the wire value stays "cortex"), command (restart_process / start_process / stop_process against the machines in scope; site admins only).

SCOPE: omit "scope" to cover every machine in the site. To target specific machines pass {"machineIds":["<id>",...]} using ids you already hold from the site context or that the operator gave you — never invent, guess, or derive a machine id, and never pass a display name in place of an id. If you do not have the id, ask.

COPY STYLE: "name" and "description" are shown in the dashboard, which is all lowercase — write them lowercase (e.g. "restart td when the wall goes black").

LIMITS: 20 talons per site. name 80 characters or fewer, description 500 or fewer. cooldownMinutes 0-1440 (default 60) is the minimum gap between runs.`,
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short lowercase name shown in the dashboard, 80 characters or fewer.',
        },
        description: {
          type: 'string',
          description: 'Optional lowercase note about what the talon is for, 500 characters or fewer.',
        },
        trigger: {
          type: 'object',
          description: 'What makes the talon fire. One of the four shapes in the tool description (schedule entries, schedule interval, threshold, event).',
        },
        condition: {
          type: 'object',
          description: 'Optional gate evaluated after the trigger fires: {"type":"none"} (default) or {"type":"visual_check","expectation":"...","monitor":0}.',
        },
        outputs: {
          type: 'array',
          description: 'What the talon does when it fires — 1 to 5 entries, executed in order.',
          items: talonOutputItemSchema,
        },
        scope: {
          type: 'object',
          description: 'Which machines the talon covers: {"machineIds":["..."]}, or omit entirely for every machine in the site.',
        },
        cooldownMinutes: {
          type: 'number',
          description: 'Minimum minutes between runs, 0 to 1440 (default 60).',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the talon is armed as soon as it is created (default true).',
        },
      },
      required: ['name', 'trigger', 'outputs'],
    },
  },
  {
    name: 'set_talon_enabled',
    description: 'Arm or disarm an existing talon. Enabling re-arms its schedule from now, so a talon that sat disabled for a while does not fire the moment it comes back. Disabling leaves the talon in place — it does not delete it. Get talon_id from list_talons; never guess it.',
    tier: 2,
    parameters: {
      type: 'object',
      properties: {
        talon_id: {
          type: 'string',
          description: 'The talon id, as returned by list_talons or create_talon.',
        },
        enabled: {
          type: 'boolean',
          description: 'true to arm the talon, false to disarm it.',
        },
      },
      required: ['talon_id', 'enabled'],
    },
  },
];

// Tier 3: Privileged Tools

const tier3Tools: McpToolDefinition[] = [
  {
    name: 'run_command',
    description: 'Execute a shell command on the remote machine. The command must start with an allowed command (e.g., ipconfig, systeminfo, tasklist, nvidia-smi, dxdiag). Use nvidia-smi for advanced GPU diagnostics: Mosaic topology, detailed driver info, process-level VRAM usage, ECC status. Use dxdiag for DirectX diagnostics. Returns stdout, stderr, and exit code. Set user_session=true to run in the logged-in user\'s desktop session (needed for GUI/display access).',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        user_session: {
          type: 'boolean',
          description: 'If true, run in the interactive user session instead of the service session. Required for commands that need desktop/display access.',
          default: false,
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_powershell',
    description: 'Execute a PowerShell command on the remote machine. Accepts arbitrary PowerShell — every call is audit-logged to the site events feed. Use this for quick one-shot reads and small scripts with the fixed 25s timeout. For long-running work, custom timeouts, or process-tree cleanup, use execute_script. Returns stdout, stderr, and exit code. Set user_session=true to run in the logged-in user\'s desktop session.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The PowerShell command or script to execute.',
        },
        user_session: {
          type: 'boolean',
          description: 'If true, run in the interactive user session instead of the service session. Required for commands that need desktop/display access.',
          default: false,
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'run_python',
    description: 'Execute Python code on the remote machine in the user\'s desktop session. The code runs in the agent\'s Python environment with access to installed packages (mss, psutil, etc.). Use `output_dir` variable to write output files. Use `print()` for text output.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute. Has access to output_dir for writing files and print() for text output.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file on the remote machine (max 100KB).',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute file path to read.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the remote machine. Creates the file if it does not exist.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute file path to write to.',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List the contents of a directory on the remote machine with file sizes and modification dates.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The absolute directory path to list.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'execute_script',
    description: 'Execute a PowerShell script on the remote machine with no command restrictions. Use for installing software, running diagnostics, stress tests, managing services, editing the registry, configuring the system, or any other administration task. Returns stdout, stderr, and exit code. Timeouts are capped at 3300 seconds (55 minutes). For jobs that may run longer, launch them detached instead (Start-Process with output redirected to a log file), return immediately, and schedule a follow-up to check the log or result later.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        script: {
          type: 'string',
          description: 'The PowerShell script to execute. Can be multi-line.',
        },
        timeout_seconds: {
          type: 'number',
          description: 'Timeout in seconds (default: 120, maximum: 3300 — 55 minutes). Set higher for long operations like software installs. Anything longer must run detached.',
          default: 120,
        },
        working_directory: {
          type: 'string',
          description: 'Optional working directory for script execution.',
        },
      },
      required: ['script'],
    },
  },
  {
    name: 'deploy_software',
    description: `Deploy and install software on this machine using the full deployment pipeline: download installer, run silent install, verify installation, and track progress. Creates a tracked deployment visible on the Deployments page.

CRITICAL — USER CONFIRMATION REQUIRED:
Before calling this tool, you MUST present a summary of what will be installed and WAIT for the user to explicitly confirm. Do NOT proceed without their approval. Show them: software name, version, install path, parallel install status, and any processes that will be closed. This is a destructive operation that downloads and installs software on their machine — never auto-execute.

WORKFLOW:
1. Call get_system_presets first to find presets for the software. Presets provide installer URLs, silent flags, and other configuration.
2. Gather all parameters and resolve any ambiguity by asking the user.
3. Present a clear summary of the deployment plan and ASK "Should I proceed?" — wait for explicit confirmation.
4. Only after the user confirms, call this tool. It returns immediately with a deployment ID. Installation runs in the background (5-40 min). Direct users to the [Deployments page](/deployments) to track progress.

ACTIVE HOURS:
- On Windows machines running owlette 4.1.21 or later, owlette refuses a deployment while the machine is inside its active hours, and the Deployments page shows the refusal. Tell the user before you deploy during them. On an older Windows agent a deployment installs right away; macOS and Linux can't run one.

TOUCHDESIGNER SPECIFICS:
- Provide the version number (e.g. "2025.32280") and the download URL is resolved automatically via https://download.derivative.ca/TouchDesigner.{version}.exe
- ALWAYS use the FULL installer URL (not WebInstaller) — web installers require network access during install and may fail in restricted environments.
- The /DIR flag in silent_flags is auto-updated to match the version: /DIR="C:\\Program Files\\Derivative\\TouchDesigner.{version}"
- parallel_install is AUTOMATICALLY ENABLED for TouchDesigner. TD supports side-by-side builds and its installer will DESTRUCTIVELY UNINSTALL all existing TD versions in silent mode unless parallel_install is on. The agent hides existing installations from the registry so the installer cannot detect and remove them.
- verify_path is auto-derived from /DIR — no need to specify it.

PARALLEL INSTALL:
- When enabled, the agent temporarily hides existing registry keys for the software so the installer cannot detect and uninstall previous versions. Keys are always restored after installation, even on failure.
- Auto-enabled for TouchDesigner. For other software, ASK the user if they want to keep existing versions before enabling.
- Only relevant for Inno Setup installers that auto-remove previous versions in silent mode.

SILENT FLAGS:
- These are command-line arguments passed to the installer for unattended installation. They vary by installer type.
- Inno Setup (TouchDesigner, etc.): /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="install\\path"
- NSIS: /S /D=install\\path
- MSI: /quiet /norestart INSTALLDIR="install\\path"
- If the user doesn't know the flags, check get_system_presets or ask them what installer technology the software uses.

WHEN TO ASK THE USER:
- Missing version number for version-specific software (e.g. TouchDesigner without a build number)
- No matching system preset and no installer URL provided
- Unclear whether to replace or install alongside existing versions (for non-TD software)
- Silent flags unknown and no preset available
- Never guess versions, URLs, or flags — always ask.`,
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        software_name: {
          type: 'string',
          description: 'Software name, e.g. "TouchDesigner", "Unreal Engine". Used to find a matching system preset if no preset_id is provided.',
        },
        version: {
          type: 'string',
          description: 'Software version, e.g. "2025.32280". For TouchDesigner, this constructs the download URL automatically.',
        },
        preset_id: {
          type: 'string',
          description: 'System preset ID to use as the base configuration. Get this from get_system_presets.',
        },
        installer_url: {
          type: 'string',
          description: 'Direct installer download URL (must be HTTPS). Overrides the preset URL if provided.',
        },
        installer_name: {
          type: 'string',
          description: 'Installer filename, e.g. "TouchDesigner.2025.32280.exe". Auto-derived from URL if not provided.',
        },
        silent_flags: {
          type: 'string',
          description: 'Silent installation flags. See main description for format by installer type. Overrides preset value.',
        },
        close_processes: {
          type: 'array',
          description: 'Process names to terminate before installation, e.g. ["TouchDesigner.exe"]. Overrides the preset value.',
          items: { type: 'string' },
        },
        parallel_install: {
          type: 'boolean',
          description: 'Install alongside existing versions instead of replacing them. Automatically enabled for TouchDesigner. ASK the user before enabling this for other software.',
        },
        timeout_minutes: {
          type: 'number',
          description: 'Maximum installation time in minutes (default: 40).',
          default: 40,
        },
        ...activeHoursOverrideFields('Install now even though the machine is inside its active hours.'),
      },
      required: ['software_name'],
    },
  },
  {
    name: 'reboot_machine',
    description: 'Reboot the remote machine after a 60-second countdown, so running processes can be saved; cancel_reboot stops it. On Windows machines running owlette 4.1.21 or later, owlette refuses a reboot while the machine is inside its active hours: when: after_active_hours restarts it as soon as they end instead.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          enum: ['now', 'after_active_hours'],
          description: "now (default): restart after the countdown. after_active_hours: wait until the machine's active hours end, then restart; outside active hours it restarts now. cancel_reboot cancels a waiting restart too. Only Windows machines running owlette 4.1.21 or later can wait; on any other machine owlette refuses after_active_hours, because its agent would restart at once.",
        },
        ...activeHoursOverrideFields('Restart now even though the machine is inside its active hours.'),
      },
    },
  },
  {
    name: 'shutdown_machine',
    description: 'Shut down the remote machine after a 60-second countdown; cancel_reboot stops it. The machine will NOT automatically restart. On Windows machines running owlette 4.1.21 or later, owlette refuses a shutdown while the machine is inside its active hours.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {
        ...activeHoursOverrideFields('Shut down now even though the machine is inside its active hours.'),
      },
    },
  },
  {
    name: 'cancel_reboot',
    description: 'Cancel a pending reboot or shutdown on the remote machine: one in its 60-second countdown, or a reboot waiting for active hours to end.',
    tier: 3,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

export const allTools: McpToolDefinition[] = [
  ...tier1Tools,
  ...tier2Tools,
  ...tier3Tools,
];

export function getToolsByTier(maxTier: ToolTier): McpToolDefinition[] {
  return allTools.filter((t) => t.tier <= maxTier);
}

export function getToolByName(name: string): McpToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

/** Convert to the Vercel AI SDK's schema format. */
export function toAISDKTools(tools: McpToolDefinition[]) {
  const result: Record<string, { description: string; parameters: unknown }> = {};
  for (const tool of tools) {
    result[tool.name] = {
      description: tool.description,
      parameters: tool.parameters,
    };
  }
  return result;
}

/** Does this tool require user confirmation before execution? */
export function requiresConfirmation(toolName: string): boolean {
  const tool = getToolByName(toolName);
  return tool ? tool.tier >= 3 : true; // Unknown tools require confirmation
}

/** Tier 2 tools handled by the existing command system, not mcp_tools.py. */
export const EXISTING_COMMAND_MAPPINGS: Record<string, string> = {
  restart_process: 'restart_process',
  kill_process: 'kill_process',
  start_process: 'restart_process', // Start uses restart logic
  set_launch_mode: 'set_launch_mode',
  reboot_machine: 'reboot_machine',
  shutdown_machine: 'shutdown_machine',
  cancel_reboot: 'cancel_reboot',
};
