/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

interface MockProcRow {
  processId: string;
  id: string;
  name: string;
  launch_mode?: string;
  autolaunch?: boolean;
  schedules?: unknown;
  schedulePresetId?: unknown;
}

const mockWithProcessLock = jest.fn();
const mockFindProcessIndex = jest.fn((procs: MockProcRow[], id: string) =>
  procs.findIndex((p) => p.processId === id),
);
const mockStatusUpdate = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/processConfig.server', () => {
  class FakeProcessConfigError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    withProcessLock: (...args: unknown[]) => mockWithProcessLock(...args),
    findProcessIndex: (procs: MockProcRow[], id: string) => mockFindProcessIndex(procs, id),
    ProcessConfigError: FakeProcessConfigError,
  };
});
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ update: mockStatusUpdate }),
        }),
      }),
    }),
  }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { setProcessLaunchMode } from '@/lib/actions/setProcessLaunchMode.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';
import { ProcessConfigError } from '@/lib/processConfig.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const PID = 'proc-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', siteRoles: { [SITE]: 'admin' } };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

function row(): MockProcRow {
  return {
    id: PID,
    processId: PID,
    name: 'TestProc',
    launch_mode: 'off',
    autolaunch: false,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
    fn([row()]);
    return undefined;
  });
});

describe('setProcessLaunchMode', () => {
  it('sets mode=always and mirrors autolaunch', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes[0];
      return out.result;
    });
    const result = await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'always',
    });
    expect(result).toEqual({ processId: PID, mode: 'always' });
    expect(captured!.launch_mode).toBe('always');
    expect(captured!.autolaunch).toBe(true);
  });

  it('sets mode=off and clears autolaunch', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([{ ...row(), launch_mode: 'always', autolaunch: true }]);
      captured = out.processes[0];
      return out.result;
    });
    await setProcessLaunchMode(CTX, { machineId: MACHINE, processId: PID, mode: 'off' });
    expect(captured!.launch_mode).toBe('off');
    expect(captured!.autolaunch).toBe(false);
  });

  it('rejects mode=scheduled without schedules', async () => {
    await expect(
      setProcessLaunchMode(CTX, { machineId: MACHINE, processId: PID, mode: 'scheduled' }),
    ).rejects.toThrow(ActionInputError);
  });

  it('accepts mode=scheduled with valid schedules', async () => {
    const result = await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'scheduled',
      schedules: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }],
    });
    expect(result.mode).toBe('scheduled');
  });

  it.each([
    ['a time no clock has', [{ days: ['mon'], ranges: [{ start: '24:00', stop: '17:00' }] }]],
    ['a block that is not an object', ['mon-fri 09:00-17:00']],
    ['schedules that are not an array', 'mon-fri 09:00-17:00'],
  ])('rejects %s before anything is written, in any mode', async (_label, schedules) => {
    for (const mode of ['scheduled', 'always'] as const) {
      await expect(
        setProcessLaunchMode(CTX, {
          machineId: MACHINE,
          processId: PID,
          mode,
          schedules: schedules as never,
        }),
      ).rejects.toThrow(ActionInputError);
    }
    expect(mockWithProcessLock).not.toHaveBeenCalled();
  });

  it('rejects an invalid mode', async () => {
    await expect(
      // @ts-expect-error — testing runtime validation
      setProcessLaunchMode(CTX, { machineId: MACHINE, processId: PID, mode: 'banana' }),
    ).rejects.toThrow(ActionInputError);
  });

  it('writes status-doc mirror when mode is set', async () => {
    await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'always',
    });
    expect(mockStatusUpdate).toHaveBeenCalledTimes(1);
    const call = mockStatusUpdate.mock.calls[0][0] as Record<string, unknown>;
    expect(call[`metrics.processes.${PID}.launch_mode`]).toBe('always');
    expect(call[`metrics.processes.${PID}.autolaunch`]).toBe(true);
  });

  it('continues when status-doc mirror fails (non-critical)', async () => {
    mockStatusUpdate.mockRejectedValueOnce(new Error('mirror down'));
    const result = await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'always',
    });
    expect(result.mode).toBe('always');
  });

  it('propagates ProcessConfigError when process not found', async () => {
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => fn([]));
    await expect(
      setProcessLaunchMode(CTX, { machineId: MACHINE, processId: PID, mode: 'off' }),
    ).rejects.toThrow(ProcessConfigError);
  });

  it('emits process_mutated audit with the mode set', async () => {
    await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'always',
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: PID,
        attributes: expect.objectContaining({
          verb: 'set_launch_mode',
          mode: 'always',
        }),
      }),
    );
  });

  it('passes schedules into config write when provided', async () => {
    let captured: MockProcRow | null = null;
    mockWithProcessLock.mockImplementation(async (_s, _m, fn) => {
      const out = fn([row()]);
      captured = out.processes[0];
      return out.result;
    });
    await setProcessLaunchMode(CTX, {
      machineId: MACHINE,
      processId: PID,
      mode: 'scheduled',
      schedules: [{ days: ['mon'], ranges: [{ start: '08:00', stop: '12:00' }] }],
    });
    expect(captured!.schedules).toEqual([
      { days: ['mon'], ranges: [{ start: '08:00', stop: '12:00' }] },
    ]);
  });
});
