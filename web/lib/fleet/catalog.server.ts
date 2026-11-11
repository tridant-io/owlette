/**
 * the tools a granted machine sees, up to the grant's tier: the ones the
 * server answers itself (`serverTools`, the fleet's own `list_machines` first)
 * and hoot's machine tools, which are queued to an agent. every tool that acts
 * on a machine names it with `machine`, and a machine never carries an
 * active-hours override.
 */

import {
  allTools,
  withoutActiveHoursOverride,
  type McpToolDefinition,
  type ToolTier,
} from '@/lib/mcp-tools';
import { SERVER_SIDE_TOOLS } from '@/lib/hoot-utils.server';
import { stripActiveHoursOverride } from '@/lib/actions/executeMachineCommand.server';
import type { FleetServerTool } from '@/lib/fleet/context';
import { hootServerTools } from '@/lib/fleet/tools/hoot.server';
import { listMachinesTool } from '@/lib/fleet/tools/machines.server';

export const MACHINE_PARAM = 'machine';

/** a new area's tools join here. */
const serverTools: readonly FleetServerTool[] = [listMachinesTool, ...hootServerTools];

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
  ...serverTools.map((tool) => (tool.target === 'machine' ? withMachineParam(tool.definition) : tool.definition)),
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

/** the tool behind a catalog name when the server answers it, null when an agent does. */
export function findFleetServerTool(name: string): FleetServerTool | null {
  return serverTools.find((tool) => tool.definition.name === name) ?? null;
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
