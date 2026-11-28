/** @jest-environment node */

import type { Actor } from '@/lib/capabilities';

const mockSet = jest.fn().mockResolvedValue(undefined);
const mockEmitMutation = jest.fn();
// the config doc as it stood before the write; capture reads it inside its transaction
let mockConfigDoc: Record<string, unknown> | undefined;

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: () => ({ set: mockSet }),
        }),
      }),
    }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async () => ({ exists: mockConfigDoc !== undefined, data: () => mockConfigDoc }),
        // tx.set takes the doc ref first; drop it so every op reads mockSet the same way
        set: (_ref: unknown, data: unknown, opts: unknown) => mockSet(data, opts),
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

import { setDisplayLayout } from '@/lib/actions/setDisplayLayout.server';
import { ActionInputError, type ActionContext } from '@/lib/actions/createProcess.server';

const SITE = 'site-a';
const MACHINE = 'mach-1';
const ACTOR: Actor = { type: 'user', userId: 'uid', role: 'admin', siteRoles: { [SITE]: 'admin' } };
const CTX: ActionContext = { siteId: SITE, actor: ACTOR, auditActor: 'user:uid' };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfigDoc = undefined;
});

describe('setDisplayLayout — capture', () => {
  it('writes assigned monitors with capturedAt + capturedBy', async () => {
    const monitors = [{ deviceName: 'mon-1', x: 0, y: 0, width: 1920, height: 1080 }];
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'capture',
      monitors,
      capturedBy: 'alice@acme.com',
    });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [payload, opts] = mockSet.mock.calls[0];
    expect((payload as Record<string, unknown>).displays).toMatchObject({
      assigned: {
        monitors,
        capturedAt: '__SERVER_TS__',
        capturedBy: 'alice@acme.com',
      },
    });
    expect(opts).toEqual({ merge: true });
  });

  it('normalizes the primary monitor to the origin before persisting', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'capture',
      monitors: [
        { id: 'primary', primary: true, position: { x: 100, y: -20 } },
        { id: 'secondary', primary: false, position: { x: 2020, y: -20 } },
      ],
      capturedBy: 'alice@acme.com',
    });

    const [payload] = mockSet.mock.calls[0];
    const assigned = (payload as {
      displays: { assigned: { monitors: Array<Record<string, unknown>> } };
    }).displays.assigned;
    expect(assigned.monitors).toEqual([
      { id: 'primary', primary: true, position: { x: 0, y: 0 } },
      { id: 'secondary', primary: false, position: { x: 1920, y: 0 } },
    ]);
  });

  it('turns auto-restore off when it stores a layout where none was stored', async () => {
    // a machine from before clear turned auto-restore off: the flag on, no layout
    mockConfigDoc = { displays: { autoRestore: { enabled: true, enabledBy: 'bob@acme.com' } } };
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'capture',
      monitors: [{ deviceName: 'm' }],
      capturedBy: 'alice@acme.com',
    });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [payload] = mockSet.mock.calls[0];
    expect((payload as { displays: { autoRestore: unknown } }).displays.autoRestore).toEqual({
      enabled: false,
    });
  });

  it('leaves auto-restore alone when it replaces a stored layout', async () => {
    mockConfigDoc = {
      displays: {
        assigned: { monitors: [{ deviceName: 'old' }] },
        autoRestore: { enabled: true, enabledBy: 'bob@acme.com' },
      },
    };
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'capture',
      monitors: [{ deviceName: 'm' }],
      capturedBy: 'alice@acme.com',
    });
    const [payload] = mockSet.mock.calls[0];
    expect((payload as { displays: Record<string, unknown> }).displays).not.toHaveProperty(
      'autoRestore',
    );
  });

  it('rejects empty monitors array', async () => {
    await expect(
      setDisplayLayout(CTX, {
        machineId: MACHINE,
        op: 'capture',
        monitors: [],
        capturedBy: 'alice@acme.com',
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects missing capturedBy', async () => {
    await expect(
      setDisplayLayout(CTX, {
        machineId: MACHINE,
        op: 'capture',
        monitors: [{ deviceName: 'm' }],
        capturedBy: '',
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('rejects non-object monitor entries', async () => {
    await expect(
      setDisplayLayout(CTX, {
        machineId: MACHINE,
        op: 'capture',
        // @ts-expect-error — testing runtime validation
        monitors: ['not-an-object'],
        capturedBy: 'alice',
      }),
    ).rejects.toThrow(ActionInputError);
  });

  it('emits an audit with verb=capture', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'capture',
      monitors: [{ deviceName: 'm' }],
      capturedBy: 'alice',
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'capture' }),
      }),
    );
  });
});

describe('setDisplayLayout — set_auto_restore', () => {
  it('writes enabled=true with enabledBy + enabledAt', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'set_auto_restore',
      enabled: true,
      enabledBy: 'alice@acme.com',
    });
    const [payload] = mockSet.mock.calls[0];
    const auto = (payload as { displays: { autoRestore: Record<string, unknown> } })
      .displays.autoRestore;
    expect(auto.enabled).toBe(true);
    expect(auto.enabledBy).toBe('alice@acme.com');
    expect(auto.enabledAt).toBe('__SERVER_TS__');
  });

  it('writes enabled=false WITHOUT enabledBy/enabledAt (preserves history)', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'set_auto_restore',
      enabled: false,
    });
    const [payload] = mockSet.mock.calls[0];
    const auto = (payload as { displays: { autoRestore: Record<string, unknown> } })
      .displays.autoRestore;
    expect(auto).toEqual({ enabled: false });
  });

  it('rejects enabled=true without enabledBy', async () => {
    await expect(
      setDisplayLayout(CTX, {
        machineId: MACHINE,
        op: 'set_auto_restore',
        enabled: true,
        enabledBy: '',
      }),
    ).rejects.toThrow(ActionInputError);
  });
});

describe('setDisplayLayout — reset_breaker', () => {
  it('writes tripped=false, failures=0', async () => {
    await setDisplayLayout(CTX, { machineId: MACHINE, op: 'reset_breaker' });
    const [payload] = mockSet.mock.calls[0];
    const breaker = (
      payload as {
        displays: { autoRestore: { circuitBreaker: Record<string, unknown> } };
      }
    ).displays.autoRestore.circuitBreaker;
    expect(breaker).toEqual({ tripped: false, failures: 0 });
  });

  it('emits an audit with verb=reset_breaker', async () => {
    await setDisplayLayout(CTX, { machineId: MACHINE, op: 'reset_breaker' });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'reset_breaker' }),
      }),
    );
  });
});

describe('setDisplayLayout - set_remote_apply', () => {
  it('writes displays.remoteApplyEnabled', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'set_remote_apply',
      enabled: true,
    });
    const [payload, opts] = mockSet.mock.calls[0];
    expect(payload).toEqual({
      displays: {
        remoteApplyEnabled: true,
      },
    });
    expect(opts).toEqual({ merge: true });
  });

  it('emits an audit with verb=set_remote_apply', async () => {
    await setDisplayLayout(CTX, {
      machineId: MACHINE,
      op: 'set_remote_apply',
      enabled: false,
    });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({ verb: 'set_remote_apply' }),
      }),
    );
  });
});
