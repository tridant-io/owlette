/** @jest-environment node */

/**
 * Schedule preset action cores (web/lib/actions/{create,update,delete}SchedulePreset.server.ts):
 * create happy path + validation, update via built-in override (setDoc + merge) and custom
 * edit (updateDoc, 404 when missing), delete happy path + idempotent missing-doc delete.
 */

interface MockDoc {
  exists: boolean;
  data: () => Record<string, unknown>;
}

const setCalls: Array<{ path: string; payload: Record<string, unknown>; merge?: boolean }> = [];
const updateCalls: Array<{ path: string; payload: Record<string, unknown> }> = [];
const deleteCalls: Array<{ path: string }> = [];
const docState: Map<string, MockDoc> = new Map();

function makeDoc(path: string) {
  return {
    get: async () => docState.get(path) ?? { exists: false, data: () => ({}) },
    set: async (payload: Record<string, unknown>, opts?: { merge?: boolean }) => {
      setCalls.push({ path, payload, merge: opts?.merge });
      // Keep local docState in sync so the round-trip behaves.
      docState.set(path, { exists: true, data: () => payload });
    },
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
    },
    delete: async () => {
      deleteCalls.push({ path });
      docState.delete(path);
    },
  };
}

function makeCollection(path: string) {
  return {
    doc: (id: string) => makeDoc(`${path}/${id}`),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => ({
      doc: (siteId: string) => ({
        collection: (sub: string) => makeCollection(`${top}/${siteId}/${sub}`),
      }),
    }),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
  },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

import {
  createSchedulePreset,
  SchedulePresetValidationError,
} from '@/lib/actions/createSchedulePreset.server';
import {
  updateSchedulePreset,
  SchedulePresetNotFoundError,
} from '@/lib/actions/updateSchedulePreset.server';
import { deleteSchedulePreset } from '@/lib/actions/deleteSchedulePreset.server';
import type { SiteHandlerContext } from '@/lib/authorizedHandler.server';

const ctx: SiteHandlerContext = {
  actor: { type: 'user', userId: 'uid_alice', role: 'admin', siteRoles: { ['site-a']: 'admin' } },
  siteId: 'site-a',
  correlationId: 'cid_1',
  auth: { userId: 'uid_alice', keyContext: null },
  scopeCheck: { isLegacy: false },
};

beforeEach(() => {
  setCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  docState.clear();
  mockEmitMutation.mockClear();
});

describe('createSchedulePreset', () => {
  it('creates a custom preset under config/{siteId}/schedule_presets', async () => {
    const result = await createSchedulePreset(ctx, {
      name: 'Morning shift',
      blocks: [
        {
          name: 'block-a',
          colorIndex: 0,
          days: ['mon', 'tue'],
          ranges: [{ start: '09:00', stop: '17:00' }],
        },
      ],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });
    expect(result.siteId).toBe('site-a');
    expect(result.presetId).toMatch(/^sched-morning-shift-\d+$/);

    expect(setCalls).toHaveLength(1);
    const call = setCalls[0];
    expect(call.path.startsWith('config/site-a/schedule_presets/sched-morning-shift-')).toBe(true);
    expect(call.merge).toBeUndefined();
    expect(call.payload.name).toBe('Morning shift');
    expect(call.payload.isBuiltIn).toBe(false);
    expect(call.payload.createdAt).toBe('__SERVER_TS__');
  });

  it('mints an id its own delete accepts, however long the name', async () => {
    const { presetId } = await createSchedulePreset(ctx, {
      name: 'late shift '.repeat(20),
      blocks: [],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });
    await expect(deleteSchedulePreset(ctx, presetId)).resolves.toMatchObject({ presetId });
  });

  it('rejects empty name', async () => {
    await expect(
      createSchedulePreset(ctx, {
        name: '',
        blocks: [],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(SchedulePresetValidationError);
  });

  it('rejects malformed time range', async () => {
    await expect(
      createSchedulePreset(ctx, {
        name: 'Bad preset',
        blocks: [{ days: ['mon'], ranges: [{ start: '25:00', stop: '17:00' }] }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(SchedulePresetValidationError);
  });

  it('rejects invalid day code', async () => {
    await expect(
      createSchedulePreset(ctx, {
        name: 'Bad preset',
        blocks: [{ days: ['funday'], ranges: [{ start: '09:00', stop: '17:00' }] }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(SchedulePresetValidationError);
  });
});

describe('updateSchedulePreset — built-in override path', () => {
  it('uses setDoc({merge: true}) and stamps isBuiltIn:true even on first edit', async () => {
    // No existing doc: built-ins create their override on first edit.
    const result = await updateSchedulePreset(ctx, 'builtin-morning-shift', {
      name: 'Morning shift (custom)',
    });
    expect(result.isBuiltInOverride).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.isBuiltIn).toBe(true);
    expect(setCalls[0].payload.name).toBe('Morning shift (custom)');
    expect(setCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
    expect(updateCalls).toHaveLength(0);
  });
});

describe('updateSchedulePreset — custom edit path', () => {
  it('uses updateDoc when the preset exists', async () => {
    docState.set('config/site-a/schedule_presets/sched-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });

    const result = await updateSchedulePreset(ctx, 'sched-custom-1', { name: 'new name' });
    expect(result.isBuiltInOverride).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.name).toBe('new name');
    expect(updateCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
    expect(setCalls).toHaveLength(0);
  });

  it('throws SchedulePresetNotFoundError when the preset does not exist', async () => {
    await expect(
      updateSchedulePreset(ctx, 'sched-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(SchedulePresetNotFoundError);
  });

  it('rejects empty body', async () => {
    await expect(
      updateSchedulePreset(ctx, 'sched-x-1', {}),
    ).rejects.toBeInstanceOf(SchedulePresetValidationError);
  });
});

describe('deleteSchedulePreset', () => {
  it('deletes an existing preset', async () => {
    docState.set('config/site-a/schedule_presets/sched-x-1', {
      exists: true,
      data: () => ({ name: 'x' }),
    });
    const result = await deleteSchedulePreset(ctx, 'sched-x-1');
    expect(result.presetId).toBe('sched-x-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('treats missing docs as a successful idempotent delete', async () => {
    const result = await deleteSchedulePreset(ctx, 'sched-missing-1');
    expect(result.presetId).toBe('sched-missing-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects invalid preset id', async () => {
    await expect(
      deleteSchedulePreset(ctx, 'bad id with spaces'),
    ).rejects.toBeInstanceOf(SchedulePresetValidationError);
  });
});

describe('schedule preset audit emission', () => {
  it('emits preset.create on create', async () => {
    const result = await createSchedulePreset(ctx, {
      name: 'Morning shift',
      blocks: [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        siteId: 'site-a',
        actor: 'user:uid_alice',
        targetId: result.presetId,
        attributes: expect.objectContaining({
          verb: 'preset.create',
          family: 'schedule',
          presetId: result.presetId,
        }),
      }),
    );
  });

  it('emits preset.update on a custom edit', async () => {
    docState.set('config/site-a/schedule_presets/sched-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });

    await updateSchedulePreset(ctx, 'sched-custom-1', { name: 'new name' });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'sched-custom-1',
        attributes: expect.objectContaining({
          verb: 'preset.update',
          family: 'schedule',
          isBuiltInOverride: false,
        }),
      }),
    );
  });

  it('does not emit when the update target is missing', async () => {
    await expect(
      updateSchedulePreset(ctx, 'sched-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(SchedulePresetNotFoundError);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('emits preset.delete on delete', async () => {
    await deleteSchedulePreset(ctx, 'sched-x-1');

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'sched-x-1',
        attributes: expect.objectContaining({
          verb: 'preset.delete',
          family: 'schedule',
        }),
      }),
    );
  });
});
