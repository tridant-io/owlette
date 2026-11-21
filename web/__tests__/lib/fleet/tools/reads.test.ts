/** @jest-environment node */

import type { Firestore } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/fleet/reads.server', () => ({
  ...jest.requireActual('@/lib/fleet/reads.server'),
  readMetricsHistory: jest.fn(),
  readInstalledSoftware: jest.fn(),
  readAlertRules: jest.fn(),
  readAuditLog: jest.fn(),
}));

import { allTools } from '@/lib/mcp-tools';
import type { FleetAnswer, FleetContext, FleetServerTool } from '@/lib/fleet/context';
import {
  readAlertRules,
  readAuditLog,
  readInstalledSoftware,
  readMetricsHistory,
} from '@/lib/fleet/reads.server';
import { readTools } from '@/lib/fleet/tools/reads.server';

const db = {} as Firestore;
const ctx: FleetContext = {
  actor: { type: 'machine', siteId: 'site-a', machineId: 'caller', maxTier: 1, machineIds: ['m1'] },
  siteId: 'site-a',
  machineId: 'caller',
  grant: { maxTier: 1, machineIds: ['m1'] },
  correlationId: 'corr-1',
  db,
};

function tool(name: string): FleetServerTool {
  const found = readTools.find((t) => t.definition.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function runMachine(name: string, params: Record<string, unknown> = {}): Promise<FleetAnswer> {
  const found = tool(name);
  if (found.target !== 'machine') throw new Error(`${name} is not a machine tool`);
  return found.run(ctx, 'm1', params);
}

function runSite(name: string, params: Record<string, unknown> = {}, over: Partial<FleetContext> = {}): Promise<FleetAnswer> {
  const found = tool(name);
  if (found.target !== 'site') throw new Error(`${name} is not a site tool`);
  return found.run({ ...ctx, ...over }, params);
}

function body(answer: FleetAnswer): Record<string, unknown> {
  if (answer.status !== 'completed') throw new Error(`failed: ${answer.error}`);
  return JSON.parse(answer.content[0].text);
}

beforeEach(() => {
  jest.clearAllMocks();
  (readMetricsHistory as jest.Mock).mockResolvedValue({
    from: 'f',
    to: 't',
    sampleCount: 0,
    downsampled: false,
    points: [],
  });
  (readInstalledSoftware as jest.Mock).mockResolvedValue({ entries: [], matched: 0, incomplete: false });
  (readAlertRules as jest.Mock).mockResolvedValue([]);
  (readAuditLog as jest.Mock).mockResolvedValue([]);
});

describe('the read tools', () => {
  it('are four tier-1 reads with new names and a described parameter each', () => {
    expect(readTools.map((t) => [t.definition.name, t.target, t.definition.tier])).toEqual([
      ['get_metrics_history', 'machine', 1],
      ['list_installed_software', 'machine', 1],
      ['list_alert_rules', 'site', 1],
      ['get_audit_log', 'site', 1],
    ]);
    const taken = new Set(allTools.map((t) => t.name));
    for (const t of readTools) {
      expect(taken.has(t.definition.name)).toBe(false);
      expect(t.definition.parameters.properties).not.toHaveProperty('machine');
      for (const property of Object.values(t.definition.parameters.properties)) expect(property.description).toBeTruthy();
    }
  });
});

describe('get_metrics_history', () => {
  it('reads the named machine over the defaults and says every sample came back', async () => {
    (readMetricsHistory as jest.Mock).mockResolvedValue({
      from: 'f',
      to: 't',
      sampleCount: 1,
      downsampled: false,
      points: [{ time: 'x', cpu_percent: 1 }],
    });

    const result = body(await runMachine('get_metrics_history'));

    expect(readMetricsHistory).toHaveBeenCalledWith(db, 'site-a', 'm1', expect.objectContaining({ hours: 24, maxPoints: 200 }));
    expect(result).toMatchObject({ machine: 'm1', sampling: 'every sample in the window', points: [{ time: 'x', cpu_percent: 1 }] });
  });

  it('caps the range and the points, and falls back on a number that is no positive one', async () => {
    await runMachine('get_metrics_history', { hours: 9999, max_points: 99999 });
    await runMachine('get_metrics_history', { hours: -5, max_points: 'many' });
    await runMachine('get_metrics_history', { hours: 2.9, max_points: 1 });

    const asked = (readMetricsHistory as jest.Mock).mock.calls.map(([, , , opts]) => [opts.hours, opts.maxPoints]);
    expect(asked).toEqual([[168, 500], [24, 200], [2, 2]]);
  });

  it('says when it downsampled', async () => {
    (readMetricsHistory as jest.Mock).mockResolvedValue({ from: 'f', to: 't', sampleCount: 900, downsampled: true, points: [{}, {}] });

    expect(body(await runMachine('get_metrics_history')).sampling).toBe(
      'downsampled: 2 of 900 samples, evenly spaced in time',
    );
  });

  it('passes the metrics asked for and refuses one it does not know', async () => {
    await runMachine('get_metrics_history', { metrics: ['cpu_temp'] });
    expect((readMetricsHistory as jest.Mock).mock.calls[0][3].metrics).toEqual(['cpu_temp']);

    for (const metrics of [['rpm'], [], 'cpu_percent']) {
      const answer = await runMachine('get_metrics_history', { metrics });
      expect(answer.status).toBe('failed');
    }
    expect(readMetricsHistory).toHaveBeenCalledTimes(1);
  });

  it('is an empty list when the machine has no history', async () => {
    expect(body(await runMachine('get_metrics_history')).points).toEqual([]);
  });
});

describe('list_installed_software', () => {
  it('reads the named machine with a trimmed filter and the default limit', async () => {
    (readInstalledSoftware as jest.Mock).mockResolvedValue({
      entries: [{ name: 'Chrome', version: '1', publisher: null }],
      matched: 1,
      incomplete: false,
    });

    const result = body(await runMachine('list_installed_software', { name: '  chrome ' }));

    expect(readInstalledSoftware).toHaveBeenCalledWith(db, 'site-a', 'm1', { limit: 100, name: 'chrome' });
    expect(result).toEqual({ machine: 'm1', software: [{ name: 'Chrome', version: '1', publisher: null }], count: 1, matched: 1 });
  });

  it('caps the limit and drops a blank filter', async () => {
    await runMachine('list_installed_software', { limit: 99999, name: '   ' });
    await runMachine('list_installed_software', { limit: 0 });

    expect((readInstalledSoftware as jest.Mock).mock.calls.map(([, , , opts]) => opts)).toEqual([
      { limit: 500, name: undefined },
      { limit: 100, name: undefined },
    ]);
  });

  it('says incomplete when the read was full, and is empty when nothing is installed', async () => {
    expect(body(await runMachine('list_installed_software'))).toMatchObject({ software: [], count: 0, matched: 0 });
    expect(body(await runMachine('list_installed_software'))).not.toHaveProperty('incomplete');

    (readInstalledSoftware as jest.Mock).mockResolvedValue({ entries: [], matched: 2000, incomplete: true });
    expect(body(await runMachine('list_installed_software'))).toHaveProperty('incomplete');
  });
});

const WHOLE_SITE = { maxTier: 1 as const, machineIds: null };
const NAMED = { maxTier: 1 as const, machineIds: ['m1'] };
const EMPTY = { maxTier: 1 as const, machineIds: [] };

describe('list_alert_rules', () => {
  it('reads the rules for a whole-site grant, and is empty when there are none', async () => {
    expect(body(await runSite('list_alert_rules', {}, { grant: WHOLE_SITE }))).toEqual({ rules: [], count: 0 });

    (readAlertRules as jest.Mock).mockResolvedValue([{ id: 'r1' }]);
    expect(body(await runSite('list_alert_rules', {}, { grant: WHOLE_SITE }))).toEqual({ rules: [{ id: 'r1' }], count: 1 });
    expect(readAlertRules).toHaveBeenCalledWith(db, 'site-a');
  });

  it('refuses a grant naming machines and an empty one, reading nothing', async () => {
    for (const grant of [NAMED, EMPTY]) {
      const answer = await runSite('list_alert_rules', {}, { grant });
      expect(answer).toMatchObject({ status: 'failed', error: expect.stringContaining('whole site') });
    }
    expect(readAlertRules).not.toHaveBeenCalled();
  });
});

describe('get_audit_log', () => {
  it('reads with the default limit for a whole-site grant, and is empty for an empty log', async () => {
    expect(body(await runSite('get_audit_log', {}, { grant: WHOLE_SITE }))).toEqual({ records: [], count: 0 });
    expect(readAuditLog).toHaveBeenCalledWith(db, 'site-a', { limit: 50, sinceMs: undefined });

    (readAuditLog as jest.Mock).mockResolvedValue([{ hash: 'h1' }]);
    expect(body(await runSite('get_audit_log', {}, { grant: WHOLE_SITE }))).toEqual({ records: [{ hash: 'h1' }], count: 1 });
  });

  it('caps the limit and takes since as unix ms or a date', async () => {
    await runSite('get_audit_log', { limit: 99999, since: '1700000000000' }, { grant: WHOLE_SITE });
    await runSite('get_audit_log', { limit: -1, since: '2026-11-01T00:00:00Z' }, { grant: WHOLE_SITE });

    expect((readAuditLog as jest.Mock).mock.calls.map(([, , opts]) => opts)).toEqual([
      { limit: 200, sinceMs: 1700000000000 },
      { limit: 50, sinceMs: Date.parse('2026-11-01T00:00:00Z') },
    ]);
  });

  it('refuses a since that is no date', async () => {
    for (const since of ['yesterday', 0, -4, {}]) {
      expect((await runSite('get_audit_log', { since }, { grant: WHOLE_SITE })).status).toBe('failed');
    }
    expect(readAuditLog).not.toHaveBeenCalled();
  });

  it('refuses a grant naming machines and an empty one, reading nothing', async () => {
    for (const grant of [NAMED, EMPTY]) {
      const answer = await runSite('get_audit_log', {}, { grant });
      expect(answer).toMatchObject({ status: 'failed', error: expect.stringContaining('whole site') });
    }
    expect(readAuditLog).not.toHaveBeenCalled();
  });
});
