/** @jest-environment node */

// the catalog's imports (hoot-utils.server, executeMachineCommand.server) reach
// the admin sdk, which initialises on import.
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));

import {
  LIST_MACHINES_TOOL,
  MACHINE_PARAM,
  fleetCatalog,
  findFleetTool,
  splitFleetParams,
  toMcpTool,
} from '@/lib/fleet/catalog.server';
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

function machineTools(maxTier: ToolTier) {
  return fleetCatalog(maxTier).filter((def) => def.name !== LIST_MACHINES_TOOL);
}

describe('fleetCatalog', () => {
  it.each(TIERS)('at tier %i holds the machine tools up to that tier plus list_machines', (tier) => {
    const expected = allTools.filter((def) => def.tier <= tier && !SERVER_SIDE_TOOLS.has(def.name));
    const catalog = fleetCatalog(tier);
    expect(catalog).toHaveLength(expected.length + 1);
    expect(catalog.map((def) => def.name)).toEqual([LIST_MACHINES_TOOL, ...expected.map((def) => def.name)]);
    for (const def of catalog) expect(def.tier).toBeLessThanOrEqual(tier);
  });

  it('starts with list_machines at tier 1, taking no parameters', () => {
    const [first] = fleetCatalog(1);
    expect(first.name).toBe(LIST_MACHINES_TOOL);
    expect(first.tier).toBe(1);
    expect(first.parameters.properties).toEqual({});
    expect(first.parameters.required).toBeUndefined();
  });

  it('leaves out every server-side tool', () => {
    const names = fleetCatalog(3).map((def) => def.name);
    for (const name of SERVER_SIDE_TOOLS) expect(names).not.toContain(name);
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
      const source = withoutActiveHoursOverride(allTools.find((tool) => tool.name === def.name)!);
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

  it('returns null for a server-side tool', () => {
    for (const name of SERVER_SIDE_TOOLS) expect(findFleetTool(name, 3)).toBeNull();
  });

  it('returns null for an unknown name', () => {
    expect(findFleetTool('no_such_tool', 3)).toBeNull();
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
