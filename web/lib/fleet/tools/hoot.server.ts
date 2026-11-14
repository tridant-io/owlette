/**
 * the tools hoot runs on the server that a granted machine may call itself:
 * the site's activity log, and the processes owlette manages on a machine.
 * left out: talons and follow-ups, which need a person or a chat, and
 * `deploy_software` with its presets, which queues outside
 * `executeMachineCommand`.
 */

import { executeServerSideTool } from '@/lib/hoot-utils.server';
import { allTools, type McpToolDefinition } from '@/lib/mcp-tools';
import { grantCovers } from '@/lib/fleet/policy.server';
import type { FleetAnswer, FleetServerTool } from '@/lib/fleet/context';

const SITE_LOGS_TOOL = 'get_site_logs';
// get_site_logs' own default and cap
const SITE_LOGS_DEFAULT = 50;
const SITE_LOGS_MAX = 200;

function hootTool(name: string): McpToolDefinition {
  const def = allTools.find((tool) => tool.name === name);
  if (!def) throw new Error(`hoot has no tool named ${name}`);
  return def;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** hoot's tools report a failure in their result and do not throw. */
function answerFrom(result: unknown): FleetAnswer {
  if (isRecord(result) && result.ok !== true && (result.ok === false || typeof result.error === 'string')) {
    const error = typeof result.error === 'string' ? result.error : 'the tool failed';
    return { status: 'failed', error: typeof result.detail === 'string' ? `${error}: ${result.detail}` : error };
  }
  return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
}

const siteLogsTool: FleetServerTool = {
  target: 'site',
  definition: {
    ...hootTool(SITE_LOGS_TOOL),
    description: 'Get activity logs for the machines you may act on: errors, crashes and other events. A grant that names its machines sees only their entries, picked from the most recent 200 the site has in the window; when there were more, the result says `incomplete`, and narrowing `hours`, `level` or `action` brings a quiet machine\'s entries back in.',
  },
  async run(ctx, params) {
    // a limit or a window that is no positive number would reach the query as it is
    const { limit: askedLimit, hours, ...filters } = params;
    const limit = isPositive(askedLimit) ? Math.min(Math.max(1, Math.floor(askedLimit)), SITE_LOGS_MAX) : SITE_LOGS_DEFAULT;
    const wholeSite = ctx.grant.machineIds === null;
    // a grant that names no machine has no entries to find, so nothing is read
    if (ctx.grant.machineIds?.length === 0) return answerFrom({ logs: [], count: 0 });
    // the log is read site-wide, so a grant that names its machines asks for
    // the most one read gives and keeps theirs
    const result = await executeServerSideTool(
      ctx.db,
      ctx.siteId,
      [],
      SITE_LOGS_TOOL,
      { ...filters, ...(isPositive(hours) ? { hours } : {}), limit: wholeSite ? limit : SITE_LOGS_MAX },
      {},
    );
    if (wholeSite || !isRecord(result) || !Array.isArray(result.logs)) return answerFrom(result);

    const logs = result.logs
      .filter((row) => isRecord(row) && typeof row.machine === 'string' && grantCovers(ctx.grant, row.machine))
      .slice(0, limit);
    return answerFrom({
      ...result,
      logs,
      count: logs.length,
      // the read came back full, so older entries of these machines may be beyond it
      ...(result.logs.length >= SITE_LOGS_MAX
        ? { incomplete: 'the site may hold more entries in this window than one read returns: narrow hours, level or action' }
        : {}),
    });
  },
};

function processTool(name: string): FleetServerTool {
  return {
    target: 'machine',
    definition: hootTool(name),
    run: async (ctx, machine, params) =>
      answerFrom(
        await executeServerSideTool(ctx.db, ctx.siteId, [machine], name, params, { machineActor: ctx.actor }),
      ),
  };
}

export const hootServerTools: readonly FleetServerTool[] = [
  siteLogsTool,
  processTool('update_process'),
  processTool('add_process'),
  processTool('delete_process'),
];
