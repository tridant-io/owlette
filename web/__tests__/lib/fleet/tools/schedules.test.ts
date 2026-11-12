/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({ getAdminDb: jest.fn(), getAdminAuth: jest.fn() }));
jest.mock('@/lib/auditLogClient', () => ({ emitMutation: jest.fn() }));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/lib/actions/setRestartSchedule.server', () => ({ setRestartSchedule: jest.fn() }));

import { setRestartSchedule } from '@/lib/actions/setRestartSchedule.server';
import { ActionInputError } from '@/lib/actions/createProcess.server';
import type { FleetContext, FleetServerTool } from '@/lib/fleet/context';
import { allTools } from '@/lib/mcp-tools';
import { scheduleTools } from '@/lib/fleet/tools/schedules.server';

const SITE = 'site-a';
const SENDER = 'sender-1';
const M1 = 'kiosk-1';

const mockSet = setRestartSchedule as jest.Mock;

let configDocs: Map<string, Record<string, unknown>>;
const reads: string[] = [];

const db = {
  collection: (a: string) => ({
    doc: (siteId: string) => ({
      collection: (b: string) => ({
        doc: (id: string) => ({
          get: async () => {
            const path = `${a}/${siteId}/${b}/${id}`;
            reads.push(path);
            const data = configDocs.get(path);
            return { exists: data !== undefined, data: () => data };
          },
        }),
      }),
    }),
  }),
} as unknown as Firestore;

const ctx: FleetContext = {
  actor: { type: 'machine', siteId: SITE, machineId: SENDER, maxTier: 3, machineIds: [M1] },
  siteId: SITE,
  machineId: SENDER,
  grant: { maxTier: 3, machineIds: [M1] },
  correlationId: 'corr-1',
  db,
};

function tool(name: string): Extract<FleetServerTool, { target: 'machine' }> {
  const found = scheduleTools.find((t) => t.definition.name === name);
  if (!found || found.target !== 'machine') throw new Error(`no machine tool ${name}`);
  return found;
}

const textOf = (answer: Awaited<ReturnType<FleetServerTool['run']>>) => {
  if (answer.status !== 'completed') throw new Error(`expected completed, got ${answer.error}`);
  return JSON.parse(answer.content[0].text);
};

beforeEach(() => {
  jest.clearAllMocks();
  configDocs = new Map();
  reads.length = 0;
});

describe('definitions', () => {
  it('are machine tools at the right tiers, with names hoot does not already have', () => {
    expect(scheduleTools.map((t) => [t.definition.name, t.target, t.definition.tier])).toEqual([
      ['get_reboot_schedule', 'machine', 1],
      ['set_reboot_schedule', 'machine', 3],
    ]);
    for (const t of scheduleTools) {
      expect(allTools.some((a) => a.name === t.definition.name)).toBe(false);
      expect(t.definition.parameters.properties).not.toHaveProperty('machine');
    }
  });
});

describe('get_reboot_schedule', () => {
  it('returns the schedule from the machine\'s config doc', async () => {
    const schedule = { enabled: true, entries: [{ id: 'a', days: ['mon'], time: '03:00' }] };
    configDocs.set(`config/${SITE}/machines/${M1}`, { rebootSchedule: schedule, processes: [] });
    const body = textOf(await tool('get_reboot_schedule').run(ctx, M1, {}));
    expect(body).toEqual({ machine: M1, schedule });
    expect(reads).toEqual([`config/${SITE}/machines/${M1}`]);
  });

  it('answers null for a machine with no schedule', async () => {
    configDocs.set(`config/${SITE}/machines/${M1}`, { processes: [] });
    expect(textOf(await tool('get_reboot_schedule').run(ctx, M1, {}))).toEqual({ machine: M1, schedule: null });
  });

  it('answers null for a machine with no config doc', async () => {
    expect(textOf(await tool('get_reboot_schedule').run(ctx, M1, {}))).toEqual({ machine: M1, schedule: null });
  });
});

describe('set_reboot_schedule', () => {
  const entries = [{ id: 'a', days: ['mon', 'fri'], time: '03:00' }];

  it('calls the core as the calling machine, for the named machine', async () => {
    mockSet.mockResolvedValue({ machineId: M1 });
    const answer = await tool('set_reboot_schedule').run(ctx, M1, { enabled: true, entries });
    expect(textOf(answer)).toEqual({ machine: M1, ok: true });
    expect(mockSet).toHaveBeenCalledWith(
      { siteId: SITE, actor: ctx.actor, auditActor: `machine:${SENDER}` },
      { machineId: M1, schedule: { enabled: true, entries } },
    );
  });

  it('clears a schedule with enabled false and no entries', async () => {
    mockSet.mockResolvedValue({ machineId: M1 });
    await tool('set_reboot_schedule').run(ctx, M1, { enabled: false, entries: [] });
    expect(mockSet.mock.calls[0][1]).toEqual({ machineId: M1, schedule: { enabled: false, entries: [] } });
  });

  it('turns a core input error into a failed answer', async () => {
    mockSet.mockRejectedValue(new ActionInputError(400, 'invalid_schedule_entry', 'Schedule entry `time` must be in HH:MM 24h format.'));
    expect(await tool('set_reboot_schedule').run(ctx, M1, { enabled: true, entries: [{ id: 'a', days: ['mon'], time: '25:00' }] }))
      .toEqual({ status: 'failed', error: 'Schedule entry `time` must be in HH:MM 24h format.' });
  });

  it('rethrows anything else', async () => {
    mockSet.mockRejectedValue(new Error('firestore down'));
    await expect(tool('set_reboot_schedule').run(ctx, M1, { enabled: true, entries })).rejects.toThrow('firestore down');
  });
});
