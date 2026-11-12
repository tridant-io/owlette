/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

const mockLoad = jest.fn();
jest.mock('@/lib/display/settings.server', () => ({
  loadDisplaySettings: (...args: unknown[]) => mockLoad(...args),
}));

import type { FleetContext, FleetServerTool } from '@/lib/fleet/context';
import {
  displayTools,
  GET_SAVED_DISPLAY_LAYOUT_TOOL,
  GET_SITE_DISPLAY_SETTINGS_TOOL,
} from '@/lib/fleet/tools/displays.server';
import { allTools } from '@/lib/mcp-tools';

type Data = Record<string, unknown>;

let docs: Map<string, Data>;
const reads: string[] = [];

const db = {
  collection: (a: string) => ({
    doc: (b: string) => ({
      collection: (c: string) => ({
        doc: (d: string) => ({
          get: async () => {
            const path = `${a}/${b}/${c}/${d}`;
            reads.push(path);
            const data = docs.get(path);
            return { exists: data !== undefined, data: () => data };
          },
        }),
      }),
    }),
  }),
} as unknown as Firestore;

function ctxFor(machineIds: string[] | null): FleetContext {
  return {
    actor: { type: 'machine', siteId: 'site-a', machineId: 'sender-1', maxTier: 1, machineIds },
    siteId: 'site-a',
    machineId: 'sender-1',
    grant: { maxTier: 1, machineIds },
    correlationId: 'corr-1',
    db,
  };
}

function find(name: string): FleetServerTool {
  const tool = displayTools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

async function layout(machine: string) {
  const tool = find(GET_SAVED_DISPLAY_LAYOUT_TOOL);
  if (tool.target !== 'machine') throw new Error('expected a machine tool');
  const answer = await tool.run(ctxFor(['kiosk-1']), machine, {});
  if (answer.status !== 'completed') throw new Error('expected completed');
  return JSON.parse((answer.content[0] as { text: string }).text);
}

const MONITOR = { id: 'm1', position: { x: 0, y: 0 }, resolution: { width: 1920, height: 1080 }, primary: true };

beforeEach(() => {
  mockLoad.mockReset();
  docs = new Map();
  reads.length = 0;
});

describe('tool definitions', () => {
  it('are tier 1 reads whose names no other tool has', () => {
    expect(displayTools).toHaveLength(2);
    for (const tool of displayTools) {
      expect(tool.definition.tier).toBe(1);
      expect(allTools.filter((t) => t.name === tool.definition.name)).toHaveLength(0);
    }
    expect(find(GET_SAVED_DISPLAY_LAYOUT_TOOL).target).toBe('machine');
    expect(find(GET_SITE_DISPLAY_SETTINGS_TOOL).target).toBe('site');
  });
});

describe('get_saved_display_layout', () => {
  it('returns the saved monitors, when and by whom, and the auto-restore state', async () => {
    docs.set('config/site-a/machines/kiosk-1', {
      displays: {
        assigned: { monitors: [MONITOR], capturedAt: { seconds: 1700000000, nanoseconds: 0 }, capturedBy: 'alice@acme.com' },
        autoRestore: { enabled: true, enabledBy: 'alice@acme.com', circuitBreaker: { tripped: true, failures: 3, lastError: 'boom' } },
        remoteApplyEnabled: true,
      },
    });
    const result = await layout('kiosk-1');
    expect(reads).toEqual(['config/site-a/machines/kiosk-1']);
    expect(result.assigned).toEqual({
      monitors: [MONITOR],
      capturedAt: '2023-11-14T22:13:20.000Z',
      capturedBy: 'alice@acme.com',
    });
    expect(result.autoRestore).toMatchObject({ enabled: true, circuitBreakerTripped: true, circuitBreakerFailures: 3, lastError: 'boom' });
    expect(result.remoteApplyEnabled).toBe(true);
    expect(result.note).toBeUndefined();
  });

  it('answers completed with assigned null and a note when the machine has no config document', async () => {
    const result = await layout('kiosk-1');
    expect(result.assigned).toBeNull();
    expect(result.note).toMatch(/no display layout/);
    expect(result.autoRestore.enabled).toBe(false);
    expect(result.remoteApplyEnabled).toBe(false);
  });

  it('answers the same when the document has no displays.assigned', async () => {
    docs.set('config/site-a/machines/kiosk-1', { processes: [{ name: 'a' }], displays: { remoteApplyEnabled: false } });
    const result = await layout('kiosk-1');
    expect(result.assigned).toBeNull();
    expect(result.note).toMatch(/no display layout/);
  });

  it('returns only the display fields, none of the rest of the config document', async () => {
    docs.set('config/site-a/machines/kiosk-1', {
      processes: [{ name: 'secret-app', exe_path: 'C:/secret.exe' }],
      firebase: { token: 'nope' },
      displays: { assigned: { monitors: [MONITOR], capturedBy: 'bob', extra: 'hidden' }, other: 'hidden' },
    });
    const text = JSON.stringify(await layout('kiosk-1'));
    expect(text).not.toMatch(/secret|nope|hidden|processes|firebase/);
  });

  it('cuts the monitor list at 32 and says so', async () => {
    const monitors = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}` }));
    docs.set('config/site-a/machines/kiosk-1', { displays: { assigned: { monitors } } });
    const result = await layout('kiosk-1');
    expect(result.assigned.monitors).toHaveLength(32);
    expect(result.assigned.truncated).toBe('showing 32 of 40 monitors');
  });
});

describe('get_site_display_settings', () => {
  const tool = find(GET_SITE_DISPLAY_SETTINGS_TOOL);

  it('returns the settings of the calling site', async () => {
    mockLoad.mockResolvedValue({ keepAwake: false });
    if (tool.target !== 'site') throw new Error('expected a site tool');
    const answer = await tool.run(ctxFor(null), {});
    expect(mockLoad).toHaveBeenCalledWith('site-a');
    expect(answer).toEqual({
      status: 'completed',
      content: [{ type: 'text', text: JSON.stringify({ keepAwake: false }, null, 2) }],
    });
  });

  it.each([
    ['naming one machine', ['kiosk-1']],
    ['that is empty', []],
  ])('refuses a grant %s without reading: a site setting is for a grant on the whole site', async (_case, grant) => {
    mockLoad.mockResolvedValue({ keepAwake: true });
    if (tool.target !== 'site') throw new Error('expected a site tool');
    expect(await tool.run(ctxFor(grant), {})).toEqual({
      status: 'failed',
      error: 'this belongs to the whole site, and this machine may act on only some of its machines',
    });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected read failure', async () => {
    mockLoad.mockRejectedValue(new Error('firestore down'));
    if (tool.target !== 'site') throw new Error('expected a site tool');
    await expect(tool.run(ctxFor(null), {})).rejects.toThrow('firestore down');
  });
});
