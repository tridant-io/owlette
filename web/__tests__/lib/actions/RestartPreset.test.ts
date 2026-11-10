/** @jest-environment node */

/**
 * Tests for the restart preset action cores
 * (web/lib/actions/{create,update,delete}RestartPreset.server.ts).
 * The `reboot_presets` collection name and `reboot-`/`builtin-` preset-id
 * prefixes are storage contracts and intentionally keep the legacy spelling.
 *
 * security-boundary-migration wave 3.6.
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
  return { doc: (id: string) => makeDoc(`${path}/${id}`) };
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
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));

import {
  createRestartPreset,
  RestartPresetValidationError,
} from '@/lib/actions/createRestartPreset.server';
import {
  updateRestartPreset,
  RestartPresetNotFoundError,
} from '@/lib/actions/updateRestartPreset.server';
import { deleteRestartPreset } from '@/lib/actions/deleteRestartPreset.server';
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

describe('createRestartPreset', () => {
  it('creates a custom preset under config/{siteId}/reboot_presets', async () => {
    const result = await createRestartPreset(ctx, {
      name: 'Weekday 3am',
      entries: [{ id: 'entry-1', days: ['mon', 'tue'], time: '03:00' }],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });
    expect(result.siteId).toBe('site-a');
    expect(result.presetId).toMatch(/^reboot-weekday-3am-\d+$/);

    expect(setCalls).toHaveLength(1);
    const call = setCalls[0];
    expect(call.path.startsWith('config/site-a/reboot_presets/reboot-weekday-3am-')).toBe(true);
    expect(call.merge).toBeUndefined();
    expect(call.payload.name).toBe('Weekday 3am');
    expect(call.payload.isBuiltIn).toBe(false);
    expect(call.payload.createdAt).toBe('__SERVER_TS__');
  });

  it('mints an id its own delete accepts, however long the name', async () => {
    const { presetId } = await createRestartPreset(ctx, {
      name: 'weekday restart '.repeat(20),
      entries: [],
      isBuiltIn: false,
      order: 0,
      createdBy: 'uid_alice',
    });
    await expect(deleteRestartPreset(ctx, presetId)).resolves.toMatchObject({ presetId });
  });

  it('rejects bad time string', async () => {
    await expect(
      createRestartPreset(ctx, {
        name: 'Bad',
        entries: [{ id: 'e', days: ['mon'], time: '25:99' }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(RestartPresetValidationError);
  });

  it('rejects invalid day code', async () => {
    await expect(
      createRestartPreset(ctx, {
        name: 'Bad',
        entries: [{ id: 'e', days: ['noday'], time: '03:00' }],
        isBuiltIn: false,
        order: 0,
        createdBy: 'uid_alice',
      }),
    ).rejects.toBeInstanceOf(RestartPresetValidationError);
  });
});

describe('updateRestartPreset — built-in override path', () => {
  it('uses setDoc({merge: true}) and pins isBuiltIn:true', async () => {
    const result = await updateRestartPreset(ctx, 'builtin-weekly-reboot', {
      name: 'Weekly reboot (custom)',
    });
    expect(result.isBuiltInOverride).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].merge).toBe(true);
    expect(setCalls[0].payload.isBuiltIn).toBe(true);
    expect(setCalls[0].payload.updatedAt).toBe('__SERVER_TS__');
    expect(updateCalls).toHaveLength(0);
  });
});

describe('updateRestartPreset — custom edit path', () => {
  it('uses updateDoc when the preset exists', async () => {
    docState.set('config/site-a/reboot_presets/reboot-custom-1', {
      exists: true,
      data: () => ({ name: 'old', isBuiltIn: false }),
    });
    const result = await updateRestartPreset(ctx, 'reboot-custom-1', { name: 'new name' });
    expect(result.isBuiltInOverride).toBe(false);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].payload.name).toBe('new name');
  });

  it('throws RestartPresetNotFoundError when missing', async () => {
    await expect(
      updateRestartPreset(ctx, 'reboot-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(RestartPresetNotFoundError);
  });

  it('rejects empty body', async () => {
    await expect(
      updateRestartPreset(ctx, 'reboot-x-1', {}),
    ).rejects.toBeInstanceOf(RestartPresetValidationError);
  });
});

describe('deleteRestartPreset', () => {
  it('deletes an existing preset', async () => {
    docState.set('config/site-a/reboot_presets/reboot-x-1', {
      exists: true,
      data: () => ({ name: 'x' }),
    });
    const result = await deleteRestartPreset(ctx, 'reboot-x-1');
    expect(result.presetId).toBe('reboot-x-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('treats missing docs as a successful idempotent delete', async () => {
    const result = await deleteRestartPreset(ctx, 'reboot-missing-1');
    expect(result.presetId).toBe('reboot-missing-1');
    expect(deleteCalls).toHaveLength(1);
  });

  it('rejects invalid preset id', async () => {
    await expect(
      deleteRestartPreset(ctx, 'bad id'),
    ).rejects.toBeInstanceOf(RestartPresetValidationError);
  });
});

describe('restart preset audit emission', () => {
  it('emits preset.create on create', async () => {
    const result = await createRestartPreset(ctx, {
      name: 'Weekday 3am',
      entries: [{ id: 'entry-1', days: ['mon'], time: '03:00' }],
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
          family: 'reboot',
          presetId: result.presetId,
        }),
      }),
    );
  });

  it('emits preset.update on a built-in override', async () => {
    await updateRestartPreset(ctx, 'builtin-weekly-reboot', { name: 'renamed' });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'builtin-weekly-reboot',
        attributes: expect.objectContaining({
          verb: 'preset.update',
          family: 'reboot',
          isBuiltInOverride: true,
        }),
      }),
    );
  });

  it('does not emit when the update target is missing', async () => {
    await expect(
      updateRestartPreset(ctx, 'reboot-missing-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(RestartPresetNotFoundError);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('emits preset.delete on delete', async () => {
    await deleteRestartPreset(ctx, 'reboot-x-1');

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: 'reboot-x-1',
        attributes: expect.objectContaining({
          verb: 'preset.delete',
          family: 'reboot',
        }),
      }),
    );
  });
});
