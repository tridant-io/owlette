/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: mockSet }),
        }),
      }),
    }),
  }),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    serverTimestamp: () => '__SERVER_TS__',
    delete: () => '__DELETE__',
  },
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { clearDisplayLayout } from '@/lib/actions/clearDisplayLayout.server';
import type { ActionContext } from '@/lib/actions/createProcess.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', siteRoles: { [SITE]: 'admin' } };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('clearDisplayLayout', () => {
  it('writes displays.assigned = FieldValue.delete() with merge', async () => {
    await clearDisplayLayout(CTX, { machineId: MACHINE });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockSet.mock.calls[0];
    expect((payload as { displays: { assigned: unknown } }).displays.assigned).toBe(
      '__DELETE__',
    );
    expect(opts).toEqual({ merge: true });
  });

  it('turns auto-restore off in the same write, keeping its history and breaker', async () => {
    await clearDisplayLayout(CTX, { machineId: MACHINE });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [payload] = mockSet.mock.calls[0];
    expect((payload as { displays: { autoRestore: unknown } }).displays.autoRestore).toEqual({
      enabled: false,
    });
  });

  it('emits an audit with verb=clear', async () => {
    await clearDisplayLayout(CTX, { machineId: MACHINE });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'process_mutated',
        targetId: MACHINE,
        attributes: expect.objectContaining({
          verb: 'clear',
          method: 'DELETE',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('returns the machineId in the result', async () => {
    const result = await clearDisplayLayout(CTX, { machineId: MACHINE });
    expect(result).toEqual({ machineId: MACHINE });
  });
});
