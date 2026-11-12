/**
 * hoot mcp's read tools the server answers itself: a machine's metrics history
 * and installed software, and the site's alert rules and audit log. none writes.
 */

import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  HISTORY_MAX_HOURS,
  HISTORY_MAX_POINTS,
  HISTORY_METRIC_KEYS,
  readAlertRules,
  readAuditLog,
  readInstalledSoftware,
  readMetricsHistory,
  type HistoryMetric,
} from '@/lib/fleet/reads.server';
import type { FleetAnswer, FleetContext, FleetServerTool } from '@/lib/fleet/context';

const HISTORY_DEFAULT_HOURS = 24;
const HISTORY_DEFAULT_POINTS = 200;
const SOFTWARE_DEFAULT_LIMIT = 100;
const SOFTWARE_MAX_LIMIT = 500;

const HISTORY_METRICS = Object.keys(HISTORY_METRIC_KEYS) as HistoryMetric[];

function completed(result: unknown): FleetAnswer {
  return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/** a number that is no positive finite one would reach a query as it is, so it falls back to the default. */
function boundedInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

/** unix ms or an iso 8601 date, as the audit-log route takes `since`; null when it is neither. */
function parseSince(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const metricsHistoryTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: 'get_metrics_history',
    description: `Get a machine's recorded metrics over a past window: CPU, memory, disk and GPU usage and CPU and GPU temperature, the same history the dashboard charts. This is the past; use get_system_info for the current reading. The window is the last \`hours\` (up to ${HISTORY_MAX_HOURS}, default ${HISTORY_DEFAULT_HOURS}). A window with more samples than \`max_points\` (up to ${HISTORY_MAX_POINTS}, default ${HISTORY_DEFAULT_POINTS}) comes back downsampled to evenly spaced points, and the result says so with \`sampling\`.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        hours: {
          type: 'number',
          description: `How many hours back to read, up to ${HISTORY_MAX_HOURS}. Default ${HISTORY_DEFAULT_HOURS}.`,
        },
        metrics: {
          type: 'array',
          items: { type: 'string', enum: HISTORY_METRICS },
          description: 'Which metrics to return. Default: all of them.',
        },
        max_points: {
          type: 'number',
          description: `The most points to return, up to ${HISTORY_MAX_POINTS}. Default ${HISTORY_DEFAULT_POINTS}.`,
        },
      },
    },
  },
  async run(ctx, machine, params) {
    const hours = boundedInt(params.hours, HISTORY_DEFAULT_HOURS, HISTORY_MAX_HOURS);
    const maxPoints = Math.max(2, boundedInt(params.max_points, HISTORY_DEFAULT_POINTS, HISTORY_MAX_POINTS));
    let metrics = HISTORY_METRICS;
    if (params.metrics !== undefined) {
      const asked = Array.isArray(params.metrics) ? params.metrics : [];
      const unknown = asked.filter((m) => !HISTORY_METRICS.includes(m as HistoryMetric));
      if (asked.length === 0 || unknown.length > 0) {
        return { status: 'failed', error: `metrics must be a list of: ${HISTORY_METRICS.join(', ')}` };
      }
      metrics = asked as HistoryMetric[];
    }
    const history = await readMetricsHistory(ctx.db, ctx.siteId, machine, { hours, metrics, maxPoints });
    return completed({
      machine,
      from: history.from,
      to: history.to,
      metrics,
      sampling: history.downsampled
        ? `downsampled: ${history.points.length} of ${history.sampleCount} samples, evenly spaced in time`
        : 'every sample in the window',
      points: history.points,
    });
  },
};

const installedSoftwareTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: 'list_installed_software',
    description: `List the software installed on a machine, as its agent last reported it: name, version and publisher, sorted by name. Returns up to \`limit\` entries (default ${SOFTWARE_DEFAULT_LIMIT}, at most ${SOFTWARE_MAX_LIMIT}); \`matched\` says how many fit the filter, so a longer list means narrowing \`name\`.`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Keep only software whose name contains this text, ignoring case.',
        },
        limit: {
          type: 'number',
          description: `The most entries to return, up to ${SOFTWARE_MAX_LIMIT}. Default ${SOFTWARE_DEFAULT_LIMIT}.`,
        },
      },
    },
  },
  async run(ctx, machine, params) {
    const limit = boundedInt(params.limit, SOFTWARE_DEFAULT_LIMIT, SOFTWARE_MAX_LIMIT);
    const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : undefined;
    const software = await readInstalledSoftware(ctx.db, ctx.siteId, machine, { limit, name });
    return completed({
      machine,
      software: software.entries,
      count: software.entries.length,
      matched: software.matched,
      ...(software.incomplete
        ? { incomplete: 'the machine reports more entries than one read takes: narrow name' }
        : {}),
    });
  },
};

// people limited to some machines are refused the site's settings and audit log, so a grant that names its machines is too
export function wholeSiteOnly(ctx: FleetContext): FleetAnswer | null {
  if (ctx.grant.machineIds === null) return null;
  return {
    status: 'failed',
    error: 'this belongs to the whole site, and this machine may act on only some of its machines',
  };
}

const alertRulesTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: 'list_alert_rules',
    description: "List the site's alert rules: what each watches (metric, operator, value), its severity, channels, cooldown and whether it is on. The rules belong to the whole site, so only a machine that may act on every machine of the site can read them; any other is refused.",
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx) {
    const refused = wholeSiteOnly(ctx);
    if (refused) return refused;
    const rules = await readAlertRules(ctx.db, ctx.siteId);
    return completed({ rules, count: rules.length });
  },
};

const auditLogTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: 'get_audit_log',
    description: `Get the site's audit log, newest first: who changed what and when. The log belongs to the whole site, so only a machine that may act on every machine of the site can read it; any other is refused. Returns up to \`limit\` entries (default ${AUDIT_DEFAULT_LIMIT}, at most ${AUDIT_MAX_LIMIT}).`,
    tier: 1,
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'Only entries recorded at or after this time: unix milliseconds or an ISO 8601 date.',
        },
        limit: {
          type: 'number',
          description: `The most entries to return, up to ${AUDIT_MAX_LIMIT}. Default ${AUDIT_DEFAULT_LIMIT}.`,
        },
      },
    },
  },
  async run(ctx, params) {
    const refused = wholeSiteOnly(ctx);
    if (refused) return refused;
    const limit = boundedInt(params.limit, AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT);
    let sinceMs: number | undefined;
    if (params.since !== undefined) {
      const parsed = parseSince(params.since);
      if (parsed === null) return { status: 'failed', error: 'since must be unix milliseconds or an ISO 8601 date' };
      sinceMs = parsed;
    }
    const records = await readAuditLog(ctx.db, ctx.siteId, { limit, sinceMs });
    return completed({ records, count: records.length });
  },
};

export const readTools: readonly FleetServerTool[] = [
  metricsHistoryTool,
  installedSoftwareTool,
  alertRulesTool,
  auditLogTool,
];
