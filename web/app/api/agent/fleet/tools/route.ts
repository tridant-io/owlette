/**
 * GET /api/agent/fleet/tools — the tools this machine's grant offers (ADR 0017),
 * in the shape an MCP client lists them, with the site and the machine the
 * fleet session belongs to. a read: it writes no audit row.
 */

import { NextResponse } from 'next/server';
import { fleetCatalog, toMcpTool } from '@/lib/fleet/catalog.server';
import { fleetHandler } from '@/lib/fleet/handler.server';

export const GET = fleetHandler((_request, ctx) =>
  NextResponse.json({
    tools: fleetCatalog(ctx.grant.maxTier).map(toMcpTool),
    site: { id: ctx.siteId },
    machine: { id: ctx.machineId },
  }),
);
