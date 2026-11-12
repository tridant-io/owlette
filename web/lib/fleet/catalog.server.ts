/**
 * the tools a granted machine sees, up to the grant's tier: the ones the
 * server answers itself (`serverTools`, the fleet's own `list_machines` first),
 * `ask_hoot`, which hands hoot a task, and hoot's machine tools, which are
 * queued to an agent. every tool that acts
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
import { deploymentTools } from '@/lib/fleet/tools/deployments.server';
import { displayTools } from '@/lib/fleet/tools/displays.server';
import { hootServerTools } from '@/lib/fleet/tools/hoot.server';
import { listMachinesTool } from '@/lib/fleet/tools/machines.server';
import { readTools } from '@/lib/fleet/tools/reads.server';
import { roostTools } from '@/lib/fleet/tools/roost.server';
import { scheduleTools } from '@/lib/fleet/tools/schedules.server';
import { screenshotTools } from '@/lib/fleet/tools/screenshots.server';

export const MACHINE_PARAM = 'machine';
export const ASK_HOOT_TOOL = 'ask_hoot';

/** started and read in `task.server.ts`: it names several machines or none, and runs for minutes. */
const askHootTool: McpToolDefinition = {
  name: ASK_HOOT_TOOL,
  description: 'Hand hoot, owlette\'s assistant, a task in plain words and get its written answer back. hoot works on the machines you name, or on every machine you may act on, with its own tools: it can look and make bounded changes, and nothing that needs a person to approve it. Use it for work that takes several steps or judgement, and call a tool directly for one known action. A task can take a few minutes, and you may start a few an hour, one at a time.',
  tier: 2,
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'What you want done or found out, with the context hoot needs. It knows nothing of your conversation.',
      },
      machines: {
        type: 'array',
        items: { type: 'string' },
        description: 'The ids of the machines to work on, from list_machines. Leave out for every machine you may act on.',
      },
    },
    required: ['prompt'],
  },
};

/** a new area's tools join here. */
const serverTools: readonly FleetServerTool[] = [
  listMachinesTool,
  ...hootServerTools,
  ...readTools,
  ...screenshotTools,
  ...displayTools,
  ...scheduleTools,
  ...deploymentTools,
  ...roostTools,
];

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
  askHootTool,
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
