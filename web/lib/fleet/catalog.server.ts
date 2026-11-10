/**
 * the tools a granted machine sees: hoot's machine tools up to the grant's
 * tier, each naming the machine it acts on, behind the fleet's own
 * `list_machines`. server-side hoot tools are left out, and a machine never
 * carries an active-hours override.
 */

import {
  allTools,
  withoutActiveHoursOverride,
  type McpToolDefinition,
  type ToolTier,
} from '@/lib/mcp-tools';
import { SERVER_SIDE_TOOLS } from '@/lib/hoot-utils.server';
import { stripActiveHoursOverride } from '@/lib/actions/executeMachineCommand.server';

export const LIST_MACHINES_TOOL = 'list_machines';
export const MACHINE_PARAM = 'machine';

const listMachinesTool: McpToolDefinition = {
  name: LIST_MACHINES_TOOL,
  description: 'List the machines you may act on, each with its id, whether it is online, seconds since its last heartbeat, OS, agent version and whether hoot is on. Pass an id as `machine` to any other tool.',
  tier: 1,
  parameters: {
    type: 'object',
    properties: {},
  },
};

function withMachineParam(def: McpToolDefinition): McpToolDefinition {
  return {
    ...def,
    parameters: {
      ...def.parameters,
      properties: {
        [MACHINE_PARAM]: {
          type: 'string',
          description: 'the id of the machine to act on, from list_machines',
        },
        ...def.parameters.properties,
      },
      required: [MACHINE_PARAM, ...(def.parameters.required ?? [])],
    },
  };
}

const catalog: readonly McpToolDefinition[] = [
  listMachinesTool,
  ...allTools
    .filter((def) => !SERVER_SIDE_TOOLS.has(def.name))
    .map((def) => withMachineParam(withoutActiveHoursOverride(def))),
];

export function fleetCatalog(maxTier: ToolTier): McpToolDefinition[] {
  return catalog.filter((def) => def.tier <= maxTier);
}

export function findFleetTool(name: string, maxTier: ToolTier): McpToolDefinition | null {
  return fleetCatalog(maxTier).find((def) => def.name === name) ?? null;
}

export function splitFleetParams(params: unknown): {
  machine: string | null;
  toolParams: Record<string, unknown>;
} {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { machine: null, toolParams: {} };
  }
  const { [MACHINE_PARAM]: machine, ...rest } = params as Record<string, unknown>;
  return {
    machine: typeof machine === 'string' && machine.length > 0 ? machine : null,
    toolParams: stripActiveHoursOverride(rest),
  };
}

export function toMcpTool(def: McpToolDefinition): {
  name: string;
  description: string;
  inputSchema: McpToolDefinition['parameters'];
} {
  return { name: def.name, description: def.description, inputSchema: def.parameters };
}
