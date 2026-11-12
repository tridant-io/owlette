/** @jest-environment node */

// the catalog's imports (hoot-utils.server, executeMachineCommand.server) reach
// the admin sdk, which initialises on import.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));

import {
  ASK_HOOT_TOOL,
  MACHINE_PARAM,
  fleetCatalog,
  findFleetServerTool,
  findFleetTool,
  splitFleetParams,
  toMcpTool,
} from '@/lib/fleet/catalog.server';
import { LIST_MACHINES_TOOL } from '@/lib/fleet/tools/machines.server';
import {
  ACTIVE_HOURS_OVERRIDE_PARAMS,
  allTools,
  takesActiveHoursOverride,
  withoutActiveHoursOverride,
  type ToolTier,
} from '@/lib/mcp-tools';
import { SERVER_SIDE_TOOLS } from '@/lib/hoot-utils.server';
import { ACTIVE_HOURS_OVERRIDE_KEYS } from '@/lib/actions/executeMachineCommand.server';

const TIERS: ToolTier[] = [1, 2, 3];

/** the tools the server answers itself, in catalog order, with the tier each needs. */
const SERVER_TOOLS: Array<[name: string, tier: ToolTier, target: 'site' | 'machine' | 'machines']> = [
  [LIST_MACHINES_TOOL, 1, 'site'],
  ['get_site_logs', 1, 'site'],
  ['update_process', 2, 'machine'],
  ['add_process', 2, 'machine'],
  ['delete_process', 2, 'machine'],
  ['get_metrics_history', 1, 'machine'],
  ['list_installed_software', 1, 'machine'],
  ['list_alert_rules', 1, 'site'],
  ['get_audit_log', 1, 'site'],
  ['list_recent_screenshots', 1, 'machine'],
  ['get_saved_display_layout', 1, 'machine'],
  ['get_site_display_settings', 1, 'site'],
  ['get_reboot_schedule', 1, 'machine'],
  ['set_reboot_schedule', 3, 'machine'],
  ['list_deployments', 1, 'site'],
  ['get_deployment', 1, 'site'],
  ['list_software_presets', 1, 'site'],
  ['create_deployment', 3, 'machines'],
  ['cancel_deployment', 2, 'machines'],
  ['update_owlette_agent', 3, 'machine'],
  ['list_roosts', 1, 'site'],
  ['list_roost_versions', 1, 'site'],
  ['deploy_roost_version', 3, 'machines'],
  ['rollback_roost', 3, 'machines'],
];

/** every catalog tool that acts on one machine, whoever answers it. */
function machineTools(maxTier: ToolTier) {
  return fleetCatalog(maxTier).filter((def) => {
    const target = findFleetServerTool(def.name)?.target;
    return def.name !== ASK_HOOT_TOOL && (target === undefined || target === 'machine');
  });
}

describe('fleetCatalog', () => {
  it.each(TIERS)('at tier %i holds the server tools, the task for hoot from tier 2, and the machine tools', (tier) => {
    const serverNames = SERVER_TOOLS.filter(([, needs]) => needs <= tier).map(([name]) => name);
    const agentNames = allTools
      .filter((def) => def.tier <= tier && !SERVER_SIDE_TOOLS.has(def.name))
      .map((def) => def.name);
    const catalog = fleetCatalog(tier);
    expect(catalog.map((def) => def.name)).toEqual([
      ...serverNames,
      ...(tier >= 2 ? [ASK_HOOT_TOOL] : []),
      ...agentNames,
    ]);
    for (const def of catalog) expect(def.tier).toBeLessThanOrEqual(tier);
  });

  it('offers ask_hoot as a tier 2 tool that takes a prompt and names its machines itself', () => {
    const def = findFleetTool(ASK_HOOT_TOOL, 2)!;
    expect(def.tier).toBe(2);
    expect(def.parameters.required).toEqual(['prompt']);
    expect(Object.keys(def.parameters.properties)).toEqual(['prompt', 'machines']);
    expect(findFleetTool(ASK_HOOT_TOOL, 1)).toBeNull();
    // neither answered inline nor queued to one machine
    expect(findFleetServerTool(ASK_HOOT_TOOL)).toBeNull();
    expect(allTools.map((tool) => tool.name)).not.toContain(ASK_HOOT_TOOL);
  });

  it('names no tool twice', () => {
    const names = fleetCatalog(3).map((def) => def.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('starts with list_machines at tier 1, taking no parameters', () => {
    const [first] = fleetCatalog(1);
    expect(first.name).toBe(LIST_MACHINES_TOOL);
    expect(first.tier).toBe(1);
    expect(first.parameters.properties).toEqual({});
    expect(first.parameters.required).toBeUndefined();
  });

  it("offers four of hoot's server-side tools and no other", () => {
    // talons and follow-ups need a person or a chat, and deploy_software with
    // its presets queues outside executeMachineCommand
    const offered = fleetCatalog(3).map((def) => def.name).filter((name) => SERVER_SIDE_TOOLS.has(name));
    expect(offered).toEqual(['get_site_logs', 'update_process', 'add_process', 'delete_process']);
  });

  it('answers a server tool that names no machine only as a tier 1 read', () => {
    // a site tool is admitted with no machine, and a machine actor holds
    // nothing but the view there
    const siteTools = fleetCatalog(3).filter((def) => findFleetServerTool(def.name)?.target === 'site');
    expect(siteTools.map((def) => def.name)).toEqual(
      SERVER_TOOLS.filter(([, , target]) => target === 'site').map(([name]) => name),
    );
    for (const def of siteTools) {
      expect(def.tier).toBe(1);
      expect(def.parameters.properties).not.toHaveProperty(MACHINE_PARAM);
    }
  });

  it('gives a tool that names several machines no machine parameter, and never tier 1', () => {
    // it names its machines in its own parameters, and dispatch checks each of them
    const manyTools = fleetCatalog(3).filter((def) => findFleetServerTool(def.name)?.target === 'machines');
    expect(manyTools.map((def) => def.name)).toEqual(
      SERVER_TOOLS.filter(([, , target]) => target === 'machines').map(([name]) => name),
    );
    for (const def of manyTools) {
      expect(def.tier).toBeGreaterThan(1);
      expect(def.parameters.properties).not.toHaveProperty(MACHINE_PARAM);
    }
  });

  it('exposes no active-hours override on any tool', () => {
    // the strip is only meaningful while hoot still offers the pair somewhere.
    expect(allTools.some(takesActiveHoursOverride)).toBe(true);
    for (const def of fleetCatalog(3)) {
      for (const name of ACTIVE_HOURS_OVERRIDE_PARAMS) {
        expect(def.parameters.properties).not.toHaveProperty(name);
        expect(def.parameters.required ?? []).not.toContain(name);
      }
    }
  });

  it('makes every machine tool require a string machine', () => {
    for (const def of machineTools(3)) {
      expect(def.parameters.required).toContain(MACHINE_PARAM);
      expect(def.parameters.properties[MACHINE_PARAM]).toEqual({
        type: 'string',
        description: 'the id of the machine to act on, from list_machines',
      });
    }
  });

  it("keeps each tool's own parameters and required list", () => {
    for (const def of machineTools(3)) {
      // an area's own tool is defined beside its code; the rest are hoot's
      const source =
        findFleetServerTool(def.name)?.definition ??
        withoutActiveHoursOverride(allTools.find((tool) => tool.name === def.name)!);
      const { [MACHINE_PARAM]: _machine, ...own } = def.parameters.properties;
      expect(own).toEqual(source.parameters.properties);
      expect(def.parameters.required).toEqual([MACHINE_PARAM, ...(source.parameters.required ?? [])]);
      expect(def.description).toBe(source.description);
      expect(def.tier).toBe(source.tier);
    }
  });

  it('never lets a hoot tool define its own machine parameter', () => {
    for (const def of allTools) {
      expect(def.parameters.properties).not.toHaveProperty(MACHINE_PARAM);
      expect(def.parameters.required ?? []).not.toContain(MACHINE_PARAM);
    }
  });

  it('never lets a hoot tool take the name list_machines', () => {
    expect(allTools.map((def) => def.name)).not.toContain(LIST_MACHINES_TOOL);
  });
});

describe('findFleetTool', () => {
  const tier3MachineTool = allTools.find((def) => def.tier === 3 && !SERVER_SIDE_TOOLS.has(def.name))!;
  const tier1MachineTool = allTools.find((def) => def.tier === 1 && !SERVER_SIDE_TOOLS.has(def.name))!;

  it('finds a tool within the tier, with machine added', () => {
    const def = findFleetTool(tier1MachineTool.name, 1);
    expect(def?.name).toBe(tier1MachineTool.name);
    expect(def?.parameters.required).toContain(MACHINE_PARAM);
  });

  it('finds list_machines at tier 1', () => {
    expect(findFleetTool(LIST_MACHINES_TOOL, 1)?.name).toBe(LIST_MACHINES_TOOL);
  });

  it('returns null for a tool above the tier', () => {
    expect(findFleetTool(tier3MachineTool.name, 2)).toBeNull();
    expect(findFleetTool(tier3MachineTool.name, 3)?.name).toBe(tier3MachineTool.name);
  });

  it('returns null for a server-side tool the fleet does not offer', () => {
    const offered = new Set(SERVER_TOOLS.map(([name]) => name));
    const withheld = [...SERVER_SIDE_TOOLS].filter((name) => !offered.has(name));
    expect(withheld.sort()).toEqual([
      'cancel_followup',
      'create_talon',
      'deploy_software',
      'get_system_presets',
      'list_talons',
      'schedule_followup',
      'set_talon_enabled',
    ]);
    for (const name of withheld) expect(findFleetTool(name, 3)).toBeNull();
  });

  it('returns null for an unknown name', () => {
    expect(findFleetTool('no_such_tool', 3)).toBeNull();
  });
});

describe('findFleetServerTool', () => {
  it.each(SERVER_TOOLS)('answers %s itself, at tier %i, on a %s', (name, tier, target) => {
    const tool = findFleetServerTool(name);
    expect(tool?.target).toBe(target);
    expect(tool?.definition.tier).toBe(tier);
    // the catalog adds `machine`; the tool's own definition never declares it
    expect(tool?.definition.parameters.properties).not.toHaveProperty(MACHINE_PARAM);
  });

  it('returns null for a tool an agent answers, and for an unknown name', () => {
    const agentTool = allTools.find((def) => !SERVER_SIDE_TOOLS.has(def.name))!;
    expect(findFleetServerTool(agentTool.name)).toBeNull();
    expect(findFleetServerTool('no_such_tool')).toBeNull();
  });
});

describe('splitFleetParams', () => {
  it('takes machine out and leaves the rest as tool params', () => {
    expect(splitFleetParams({ machine: 'm-1', process_name: 'td', limit: 5 })).toEqual({
      machine: 'm-1',
      toolParams: { process_name: 'td', limit: 5 },
    });
  });

  it.each([
    ['missing', { process_name: 'td' }],
    ['empty', { machine: '', process_name: 'td' }],
    ['a number', { machine: 7, process_name: 'td' }],
    ['null', { machine: null, process_name: 'td' }],
  ])('returns a null machine when it is %s', (_label, params) => {
    expect(splitFleetParams(params)).toEqual({ machine: null, toolParams: { process_name: 'td' } });
  });

  it.each([[undefined], [null], ['m-1'], [['m-1']]])('treats %p as no params', (params) => {
    expect(splitFleetParams(params)).toEqual({ machine: null, toolParams: {} });
  });

  it('drops every active-hours override key', () => {
    const params: Record<string, unknown> = { machine: 'm-1', process_name: 'td' };
    for (const key of ACTIVE_HOURS_OVERRIDE_KEYS) params[key] = true;
    expect(splitFleetParams(params).toolParams).toEqual({ process_name: 'td' });
  });

  it('does not mutate its input', () => {
    const params = { machine: 'm-1', process_name: 'td', override_active_hours: true };
    const before = structuredClone(params);
    splitFleetParams(params);
    expect(params).toEqual(before);
  });
});

describe('toMcpTool', () => {
  it('maps a definition to name, description and inputSchema', () => {
    const def = fleetCatalog(3)[1];
    expect(toMcpTool(def)).toEqual({
      name: def.name,
      description: def.description,
      inputSchema: def.parameters,
    });
  });
});
