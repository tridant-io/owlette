/** @jest-environment node */

import {
  allTools,
  getToolsByTier,
  getToolByName,
  toAISDKTools,
  requiresConfirmation,
  takesActiveHoursOverride,
  withoutActiveHoursOverride,
  EXISTING_COMMAND_MAPPINGS,
  type McpToolDefinition,
} from '@/lib/mcp-tools';

// Tool registry — single source of truth for every tool name that must
// exist. Adding or removing a tool in mcp-tools.ts must update this list.

const EXPECTED_TIER1 = [
  'get_site_logs',
  'get_system_info',
  'get_process_list',
  'get_running_processes',
  'get_gpu_processes',
  'get_network_info',
  'get_disk_usage',
  'get_event_logs',
  'get_service_status',
  'get_agent_config',
  'get_agent_logs',
  'get_agent_health',
  'get_system_presets',
  'check_pending_reboot',
  // Scheduled follow-ups — server-side chat records, no machine involved.
  'schedule_followup',
  'cancel_followup',
  // Members already read talons through the rules and the talons page.
  'list_talons',
] as const;

const EXPECTED_TIER2 = [
  'restart_process',
  'kill_process',
  'start_process',
  'set_launch_mode',
  'update_process',
  'add_process',
  'delete_process',
  'capture_screenshot',
  // Wave 1
  'manage_process',
  'manage_windows_service',
  'configure_gpu_tdr',
  'manage_windows_update',
  'suppress_setup_screens',
  'manage_notifications',
  'configure_power_plan',
  // Wave 2
  'manage_scheduled_task',
  'network_reset',
  'registry_operation',
  'clean_disk_space',
  'get_event_logs_filtered',
  'manage_windows_feature',
  'show_notification',
  // Talons (wave 3) — site-level automations, executed server-side.
  'create_talon',
  'set_talon_enabled',
] as const;

const EXPECTED_TIER3 = [
  'run_command',
  'run_powershell',
  'run_python',
  'execute_script',
  'read_file',
  'write_file',
  'list_directory',
  'deploy_software',
  'reboot_machine',
  'shutdown_machine',
  'cancel_reboot',
] as const;

const ALL_EXPECTED = [...EXPECTED_TIER1, ...EXPECTED_TIER2, ...EXPECTED_TIER3];


describe('mcp-tools: tool definitions', () => {
  it('exports exactly the expected number of tools', () => {
    expect(allTools).toHaveLength(ALL_EXPECTED.length);
  });

  it('every expected tool exists in allTools', () => {
    const names = allTools.map((t) => t.name);
    for (const expected of ALL_EXPECTED) {
      expect(names).toContain(expected);
    }
  });

  it('has no duplicate tool names', () => {
    const names = allTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(allTools.map((t) => [t.name, t]))('%s has valid schema', (_name, tool) => {
    const t = tool as McpToolDefinition;
    expect(t.name).toBeTruthy();
    expect(t.description).toBeTruthy();
    expect(t.description.length).toBeGreaterThan(10);
    expect([1, 2, 3]).toContain(t.tier);
    expect(t.parameters).toBeDefined();
    expect(t.parameters.type).toBe('object');
    expect(t.parameters.properties).toBeDefined();
  });
});

describe('mcp-tools: tier assignments', () => {
  it.each(EXPECTED_TIER1.map((n) => [n]))('%s is tier 1', (name) => {
    expect(getToolByName(name)?.tier).toBe(1);
  });

  it.each(EXPECTED_TIER2.map((n) => [n]))('%s is tier 2', (name) => {
    expect(getToolByName(name)?.tier).toBe(2);
  });

  it.each(EXPECTED_TIER3.map((n) => [n]))('%s is tier 3', (name) => {
    expect(getToolByName(name)?.tier).toBe(3);
  });
});

describe('mcp-tools: getToolsByTier()', () => {
  it('tier 1 returns only read-only tools', () => {
    const tools = getToolsByTier(1);
    expect(tools).toHaveLength(EXPECTED_TIER1.length);
    expect(tools.every((t) => t.tier === 1)).toBe(true);
  });

  it('tier 2 includes tier 1 + process management', () => {
    const tools = getToolsByTier(2);
    expect(tools).toHaveLength(EXPECTED_TIER1.length + EXPECTED_TIER2.length);
    expect(tools.every((t) => t.tier <= 2)).toBe(true);
  });

  it('tier 3 returns all tools', () => {
    const tools = getToolsByTier(3);
    expect(tools).toHaveLength(ALL_EXPECTED.length);
  });
});

describe('mcp-tools: getToolByName()', () => {
  it('returns the correct tool', () => {
    const tool = getToolByName('get_system_info');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_system_info');
    expect(tool!.tier).toBe(1);
  });

  it('returns undefined for unknown tools', () => {
    expect(getToolByName('nonexistent_tool')).toBeUndefined();
  });
});

describe('mcp-tools: toAISDKTools()', () => {
  it('converts all tools to AI SDK format', () => {
    const sdkTools = toAISDKTools(allTools);
    const keys = Object.keys(sdkTools);
    expect(keys).toHaveLength(allTools.length);
    for (const tool of allTools) {
      expect(sdkTools[tool.name]).toBeDefined();
      expect(sdkTools[tool.name].description).toBe(tool.description);
      expect(sdkTools[tool.name].parameters).toBe(tool.parameters);
    }
  });
});

describe('mcp-tools: requiresConfirmation()', () => {
  it('tier 1 tools do not require confirmation', () => {
    for (const name of EXPECTED_TIER1) {
      expect(requiresConfirmation(name)).toBe(false);
    }
  });

  it('tier 2 tools do not require confirmation', () => {
    for (const name of EXPECTED_TIER2) {
      expect(requiresConfirmation(name)).toBe(false);
    }
  });

  it('tier 3 tools require confirmation', () => {
    for (const name of EXPECTED_TIER3) {
      expect(requiresConfirmation(name)).toBe(true);
    }
  });

  it('unknown tools require confirmation (safe default)', () => {
    expect(requiresConfirmation('something_unknown')).toBe(true);
  });
});

describe('mcp-tools: EXISTING_COMMAND_MAPPINGS', () => {
  it('maps only to valid command types', () => {
    for (const [toolName, cmdType] of Object.entries(EXISTING_COMMAND_MAPPINGS)) {
      expect(typeof toolName).toBe('string');
      expect(typeof cmdType).toBe('string');
      expect(cmdType.length).toBeGreaterThan(0);
    }
  });

  it('every mapped tool exists in allTools', () => {
    for (const toolName of Object.keys(EXISTING_COMMAND_MAPPINGS)) {
      expect(getToolByName(toolName)).toBeDefined();
    }
  });
});

describe('mcp-tools: required parameters', () => {
  it('get_service_status requires service_name', () => {
    const tool = getToolByName('get_service_status')!;
    expect(tool.parameters.required).toContain('service_name');
  });

  it('run_command requires command', () => {
    const tool = getToolByName('run_command')!;
    expect(tool.parameters.required).toContain('command');
  });

  it('run_powershell requires script', () => {
    const tool = getToolByName('run_powershell')!;
    expect(tool.parameters.required).toContain('script');
  });

  it('read_file requires path', () => {
    const tool = getToolByName('read_file')!;
    expect(tool.parameters.required).toContain('path');
  });

  it('write_file requires path and content', () => {
    const tool = getToolByName('write_file')!;
    expect(tool.parameters.required).toContain('path');
    expect(tool.parameters.required).toContain('content');
  });

  it('list_directory requires path', () => {
    const tool = getToolByName('list_directory')!;
    expect(tool.parameters.required).toContain('path');
  });

  it('execute_script requires script', () => {
    const tool = getToolByName('execute_script')!;
    expect(tool.parameters.required).toContain('script');
  });

  it('run_python requires code', () => {
    const tool = getToolByName('run_python')!;
    expect(tool.parameters.required).toContain('code');
  });

  it('restart_process requires process_name', () => {
    const tool = getToolByName('restart_process')!;
    expect(tool.parameters.required).toContain('process_name');
  });

  it('process CRUD tools require the correct identifiers', () => {
    expect(getToolByName('update_process')!.parameters.required).toEqual(['process_name']);
    expect(getToolByName('add_process')!.parameters.required).toEqual(['name', 'exe_path']);
    expect(getToolByName('delete_process')!.parameters.required).toEqual(['process_name']);
  });

  it('deploy_software requires software_name', () => {
    const tool = getToolByName('deploy_software')!;
    expect(tool.parameters.required).toContain('software_name');
  });

  it('parameterless tools have no required fields', () => {
    const noParams = ['get_system_info', 'get_process_list', 'get_network_info', 'get_disk_usage', 'get_agent_config', 'get_agent_health', 'reboot_machine', 'shutdown_machine', 'cancel_reboot'];
    for (const name of noParams) {
      const tool = getToolByName(name)!;
      expect(tool.parameters.required ?? []).toHaveLength(0);
    }
  });
});

// Agent parity: the web definitions must match what
// agent/src/mcp_tools.py execute_tool() actually handles. Tier 2 goes through
// IPC on existing commands, not mcp_tools.py.

describe('mcp-tools: agent parity', () => {
  // Tools handled directly by mcp_tools.execute_tool()
  const AGENT_MCP_TOOLS = [
    'get_system_info', 'get_process_list', 'get_running_processes',
    'get_network_info', 'get_disk_usage', 'get_event_logs',
    'get_service_status', 'get_agent_config', 'get_agent_logs',
    'get_agent_health', 'run_command', 'run_powershell',
    'execute_script', 'read_file', 'write_file', 'list_directory',
  ];

  it('all agent mcp_tools handlers have web definitions', () => {
    for (const name of AGENT_MCP_TOOLS) {
      expect(getToolByName(name)).toBeDefined();
    }
  });

  // Tools routed via IPC or existing command system (not in mcp_tools.py)
  const IPC_TOOLS = ['restart_process', 'kill_process', 'start_process', 'set_launch_mode', 'capture_screenshot'];
  const SERVICE_TOOLS = ['reboot_machine', 'shutdown_machine', 'cancel_reboot', 'run_python'];

  it('IPC tools are tier 2', () => {
    for (const name of IPC_TOOLS) {
      expect(getToolByName(name)?.tier).toBe(2);
    }
  });

  it('service-level tools are tier 3', () => {
    for (const name of SERVICE_TOOLS) {
      expect(getToolByName(name)?.tier).toBe(3);
    }
  });

  // Server-side tools (executed on web server, not relayed to agent)
  const SERVER_SIDE_TOOLS = [
    'get_site_logs',
    'get_system_presets',
    'deploy_software',
    'update_process',
    'add_process',
    'delete_process',
    'create_talon',
    'list_talons',
    'set_talon_enabled',
    'schedule_followup',
    'cancel_followup',
  ];

  it('server-side tools have web definitions', () => {
    for (const name of SERVER_SIDE_TOOLS) {
      expect(getToolByName(name)).toBeDefined();
    }
  });
});

// Follow-up scheduling schemas. The delay/at exclusivity and the 1–10080 range
// are enforced in hoot-utils.server.ts; what the DEFINITION owes the model is a
// schema it can fill and a description that states the constraints, because
// JSON Schema `oneOf` is not part of McpToolDefinition's shape.

describe('mcp-tools: follow-up scheduling schemas', () => {
  it('schedule_followup requires only note, and offers both scheduling forms', () => {
    const tool = getToolByName('schedule_followup')!;
    expect(tool.parameters.required).toEqual(['note']);
    expect(Object.keys(tool.parameters.properties)).toEqual(
      expect.arrayContaining(['note', 'delay_minutes', 'at', 'watch_command_id']),
    );
    expect(tool.parameters.properties.delay_minutes.type).toBe('number');
    expect(tool.parameters.properties.at.type).toBe('string');
    expect(tool.parameters.properties.watch_command_id.type).toBe('string');
  });

  it('schedule_followup documents the exactly-one-of constraint and the 1-10080 range', () => {
    const tool = getToolByName('schedule_followup')!;
    const description = tool.description.toLowerCase();
    expect(description).toContain('exactly one');
    expect(description).toContain('10080');
    expect(description).toContain('seven days');
    // The per-field descriptions have to carry it too: a model filling one
    // argument at a time may never re-read the tool blurb.
    expect(tool.parameters.properties.delay_minutes.description).toMatch(/exactly one/i);
    expect(tool.parameters.properties.at.description).toMatch(/exactly one/i);
  });

  it('schedule_followup documents what watch_command_id does', () => {
    const tool = getToolByName('schedule_followup')!;
    const watch = tool.parameters.properties.watch_command_id.description.toLowerCase();
    // Early fire is the whole point of the field, and the schedule stays as the
    // backstop — say both, or the model will treat it as a replacement.
    expect(watch).toContain('finishes');
    expect(watch).toContain('whichever comes first');
  });

  it('schedule_followup names its return fields so cancel_followup is reachable', () => {
    const tool = getToolByName('schedule_followup')!;
    expect(tool.description).toContain('followup_id');
    expect(tool.description).toContain('fires_at');
  });

  it('cancel_followup takes only a followup_id', () => {
    const tool = getToolByName('cancel_followup')!;
    expect(tool.parameters.required).toEqual(['followup_id']);
    expect(Object.keys(tool.parameters.properties)).toEqual(['followup_id']);
    expect(tool.description).toContain('followup_id');
  });

  it('both follow-up tools are tier 1 — scheduling one grants no new reach', () => {
    // Re-resolving the owner's access at fire time is only half of it: that
    // bounds the fired turn by the OWNER's standing, which is more than a capped
    // turn had. So the scheduling turn's own ceiling rides on the follow-up doc
    // (`maxToolTier`) and the fire takes the lower of the two — without it a
    // tier-1 chat-scoped API key could schedule itself tier-2 reach.
    expect(getToolByName('schedule_followup')!.tier).toBe(1);
    expect(getToolByName('cancel_followup')!.tier).toBe(1);
    expect(requiresConfirmation('schedule_followup')).toBe(false);
    expect(requiresConfirmation('cancel_followup')).toBe(false);
  });
});

describe('mcp-tools: process CRUD schemas', () => {
  it('update_process exposes every supported patch field', () => {
    const tool = getToolByName('update_process')!;
    expect(Object.keys(tool.parameters.properties)).toEqual(
      expect.arrayContaining([
        'process_name',
        'name',
        'exe_path',
        'file_path',
        'cwd',
        'priority',
        'visibility',
        'time_delay',
        'time_to_init',
        'relaunch_attempts',
        'launch_mode',
        'schedules',
        'schedulePresetId',
      ]),
    );
  });

  it('add_process and update_process share process config field schemas', () => {
    const add = getToolByName('add_process')!;
    const update = getToolByName('update_process')!;
    for (const field of Object.keys(add.parameters.properties)) {
      expect(update.parameters.properties[field]).toEqual(add.parameters.properties[field]);
    }
  });
});

// Active hours: the agent refuses reboots, shutdowns and deployments inside
// them unless a person approved an override. hoot-utils forces that approval
// for any call that sets the pair; these are the schemas it keys off.

describe('mcp-tools: active-hours schemas', () => {
  const OVERRIDE_TOOLS = ['reboot_machine', 'shutdown_machine', 'deploy_software', 'manage_windows_update'];

  it('exactly the disruptive tools take the override and its reason', () => {
    expect(allTools.filter(takesActiveHoursOverride).map((t) => t.name).sort()).toEqual(
      [...OVERRIDE_TOOLS].sort(),
    );
    for (const name of OVERRIDE_TOOLS) {
      const { properties, required } = getToolByName(name)!.parameters;
      expect(properties.override_active_hours.type).toBe('boolean');
      expect(properties.reason.type).toBe('string');
      expect(properties.reason.description).toMatch(/500/);
      expect(required ?? []).not.toContain('override_active_hours');
      expect(required ?? []).not.toContain('reason');
    }
  });

  it('reboot_machine can wait for active hours to end; shutdown_machine cannot', () => {
    const when = getToolByName('reboot_machine')!.parameters.properties.when;
    expect(when.type).toBe('string');
    expect(when.enum).toEqual(['now', 'after_active_hours']);
    expect(getToolByName('shutdown_machine')!.parameters.properties).not.toHaveProperty('when');
  });

  it('manage_windows_update offers the restart actions and no longer sets a restart deadline', () => {
    const tool = getToolByName('manage_windows_update')!;
    expect(tool.parameters.properties.action.enum).toEqual(
      expect.arrayContaining([
        'get_status',
        'set_active_hours',
        'limit_auto_restart',
        'disable_auto_install',
        'enable_auto_install',
        'set_scheduled_install',
      ]),
    );
    expect(tool.parameters.properties.action.enum).not.toContain('set_restart_deadline');
    expect(tool.parameters.properties).not.toHaveProperty('deadline_days');
  });

  it('manage_windows_update says what each restart action really does', () => {
    const description = getToolByName('manage_windows_update')!.description;
    // set_scheduled_install turns on install-and-restart, not just an install time.
    expect(description).toMatch(/set_scheduled_install[^.]*restarts/);
    expect(description).toMatch(/limit_auto_restart[^.]*only outside active hours/);
    expect(description).toMatch(/nightly restart can still happen/);
    expect(description).toMatch(/disable_auto_install[^.]*security updates[^.]*wait/);
    // active hours hold Windows' restarts only until a deadline passes.
    expect(description).toMatch(/until an update deadline passes/);
    expect(description).toMatch(/owlette 4\.1\.21 or later refuses reboots, shutdowns and deployments inside them/);
    // an older agent answers "Unknown action" to the three it never had.
    expect(description).toMatch(/limit_auto_restart, disable_auto_install and enable_auto_install need owlette 4\.1\.21 or later\./);
    expect(description).not.toMatch(/quiet hours/i);
  });

  it('claims the refusal only for agents that enforce it', () => {
    // older agents, and macOS and Linux, run these at once.
    for (const name of ['reboot_machine', 'shutdown_machine', 'deploy_software']) {
      const description = getToolByName(name)!.description;
      expect(description).toMatch(/On Windows machines running owlette 4\.1\.21 or later, owlette refuses/);
      expect(description).not.toMatch(/On Windows, owlette refuses/);
    }
    // deployments are Windows only.
    expect(getToolByName('deploy_software')!.description).toMatch(
      /On an older Windows agent a deployment installs right away; macOS and Linux can't run one\./,
    );
    const registry = getToolByName('registry_operation')!.description;
    expect(registry).toMatch(/On owlette 4\.1\.21 or later it refuses to write or delete the active hours values/);
    expect(registry).not.toMatch(/\. It refuses to write or delete/);

    const when = getToolByName('reboot_machine')!.parameters.properties.when.description;
    expect(when).toMatch(/Only Windows machines running owlette 4\.1\.21 or later can wait/);
    expect(when).toMatch(/would restart at once/);

    for (const name of OVERRIDE_TOOLS) {
      expect(getToolByName(name)!.parameters.properties.override_active_hours.description).toMatch(
        /only matters on Windows machines running owlette 4\.1\.21 or later/,
      );
    }
  });

  it('the countdown the tools quote is the agent`s 60 seconds', () => {
    for (const name of ['reboot_machine', 'shutdown_machine', 'cancel_reboot']) {
      const description = getToolByName(name)!.description;
      expect(description).toMatch(/60-second/);
      expect(description).not.toMatch(/30-second/);
    }
  });

  it('withoutActiveHoursOverride drops the pair and keeps everything else', () => {
    const reboot = getToolByName('reboot_machine')!;
    const stripped = withoutActiveHoursOverride(reboot);

    expect(Object.keys(stripped.parameters.properties)).toEqual(['when']);
    expect(stripped.name).toBe('reboot_machine');
    expect(stripped.tier).toBe(reboot.tier);
    // The registry entry itself is untouched.
    expect(reboot.parameters.properties).toHaveProperty('override_active_hours');
    // A tool without the pair comes back as it was.
    const info = getToolByName('get_system_info')!;
    expect(withoutActiveHoursOverride(info)).toBe(info);
  });
});
