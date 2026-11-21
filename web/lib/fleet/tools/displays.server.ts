/**
 * the fleet's display tools: a machine's saved layout and the site's display
 * policy. the display-layout route is PUT and DELETE only, so the layout is
 * read as the dashboard's useDisplayState hook reads it.
 */

import { timestampToIso } from '@/lib/firestoreTime.server';
import { loadDisplaySettings } from '@/lib/display/settings.server';
import type { FleetServerTool } from '@/lib/fleet/context';
import { wholeSiteOnly } from '@/lib/fleet/tools/reads.server';

export const GET_SITE_DISPLAY_SETTINGS_TOOL = 'get_site_display_settings';

const getSiteDisplaySettingsTool: FleetServerTool = {
  target: 'site',
  definition: {
    name: GET_SITE_DISPLAY_SETTINGS_TOOL,
    description: 'Read the site\'s display settings. Returns `keepAwake`: whether the site\'s machines hold their screen and lock awake. It is on unless a site owner or site admin turned it off, and agents follow it. Only a machine that may act on every machine of the site can read it. This only reads; it changes nothing and is not the display layout of any machine.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx) {
    const refused = wholeSiteOnly(ctx);
    if (refused) return refused;
    const settings = await loadDisplaySettings(ctx.siteId);
    return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(settings, null, 2) }] };
  },
};

export const GET_SAVED_DISPLAY_LAYOUT_TOOL = 'get_saved_display_layout';

// a machine has a handful of monitors; this only stops a malformed document flooding the answer
const MAX_MONITORS = 32;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// parsed as useDisplayState reads the config document: partial data is normal
function readAutoRestore(raw: unknown) {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const cb = (r.circuitBreaker && typeof r.circuitBreaker === 'object' ? r.circuitBreaker : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    enabledBy: str(r.enabledBy) ?? null,
    enabledAt: timestampToIso(r.enabledAt),
    circuitBreakerTripped: cb.tripped === true,
    circuitBreakerFailures: typeof cb.failures === 'number' ? cb.failures : 0,
    lastError: str(cb.lastError) ?? null,
  };
}

const getSavedDisplayLayoutTool: FleetServerTool = {
  target: 'machine',
  definition: {
    name: GET_SAVED_DISPLAY_LAYOUT_TOOL,
    description: 'Read the display layout saved for a machine: the monitors (position, resolution, refresh rate, rotation, scale, primary), when it was saved and by whom, and whether auto-restore is on or paused by its circuit breaker. This is the layout owlette restores the machine to after a reboot or driver change, not the monitors connected now. Returns `assigned: null` and a note when nothing is saved. Shows at most 32 monitors and says when it cut any off. Only reads.',
    tier: 1,
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async run(ctx, machine) {
    const snap = await ctx.db.collection('config').doc(ctx.siteId).collection('machines').doc(machine).get();
    const displays = (snap.exists ? snap.data()?.displays : null) ?? {};
    const candidate = displays.assigned;
    const result: Record<string, unknown> = {
      assigned: null,
      autoRestore: readAutoRestore(displays.autoRestore),
      remoteApplyEnabled: displays.remoteApplyEnabled === true,
    };
    if (candidate && Array.isArray(candidate.monitors)) {
      result.assigned = {
        monitors: candidate.monitors.slice(0, MAX_MONITORS),
        capturedAt: timestampToIso(candidate.capturedAt),
        capturedBy: str(candidate.capturedBy) ?? null,
        ...(candidate.monitors.length > MAX_MONITORS ? { truncated: `showing ${MAX_MONITORS} of ${candidate.monitors.length} monitors` } : {}),
      };
    } else {
      result.note = 'no display layout is saved for this machine';
    }
    return { status: 'completed', content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};

export const displayTools: readonly FleetServerTool[] = [getSavedDisplayLayoutTool, getSiteDisplaySettingsTool];
