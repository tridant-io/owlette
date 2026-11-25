/** @jest-environment node */

/**
 * Unit tests for `web/lib/commandLifecycle.ts`, mocking firebase-admin at the
 * doc-ref level so writes can be asserted without the emulator.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

// Mocked so one writeCommandFanOut test exercises the default-db branch; the
// rest pass an explicit `db`.
const defaultSetMock = jest.fn().mockResolvedValue(undefined);
const defaultDocChain = {
  set: defaultSetMock,
};
const defaultBuildCollection = (): Record<string, unknown> => ({
  doc: jest.fn(() => ({
    ...defaultDocChain,
    collection: defaultBuildCollection,
  })),
});

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: defaultBuildCollection }),
}));

import {
  COMMAND_EXPIRY_MS,
  isTerminalCommandStatus,
  stampCommand,
  writeCommandFanOut,
  type CommandData,
} from '@/lib/commandLifecycle';

// every status the agent writes to commands/completed (firebase_client.py
// _mark_command_*, owlette_service.py progress updates), plus the legacy `error`
describe('isTerminalCommandStatus', () => {
  it.each(['completed', 'failed', 'cancelled', 'error'])('%s ends a command', (status) => {
    expect(isTerminalCommandStatus(status)).toBe(true);
  });

  it.each(['running', 'closing_processes', 'downloading', 'installing', 'uninstalling', 'pending', undefined])(
    '%s does not',
    (status) => {
      expect(isTerminalCommandStatus(status)).toBe(false);
    },
  );
});

/**
 * The fakes implement only `collection().doc().collection().doc().set()`, so
 * call sites widen through `unknown` (`as unknown as FakeFirestore`).
 */
type FakeFirestore = Parameters<typeof writeCommandFanOut>[4] extends
  | { db?: infer D }
  | undefined
  ? NonNullable<D>
  : never;

type DocStub = {
  set: jest.Mock<Promise<void>, [Record<string, unknown>, { merge?: boolean }?]>;
};

/** Fake admin Firestore recording every `.set()` path + payload. */
function buildFakeDb(): {
  db: FakeFirestore;
  calls: Array<{ path: string[]; payload: Record<string, unknown>; options?: { merge?: boolean } }>;
} {
  const calls: Array<{
    path: string[];
    payload: Record<string, unknown>;
    options?: { merge?: boolean };
  }> = [];

  function makeCollection(parentPath: string[]): {
    doc: (id: string) => unknown;
  } {
    return {
      doc: (id: string) => {
        const docPath = [...parentPath, id];
        const stub: DocStub & {
          collection: (name: string) => unknown;
        } = {
          set: jest.fn(async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
            calls.push({ path: docPath, payload, options });
          }) as DocStub['set'],
          collection: (name: string) => makeCollection([...docPath, name]),
        };
        return stub;
      },
    };
  }

  const db = { collection: (name: string) => makeCollection([name]) };
  return { db: db as unknown as FakeFirestore, calls };
}

// stampCommand

describe('stampCommand', () => {
  it('adds createdAt as a server-timestamp sentinel and expiresAt as Timestamp', () => {
    const input: CommandData = { type: 'restart_process', process_id: 'p1' };
    const stamped = stampCommand(input, { now: () => 1_700_000_000_000 });

    // createdAt is a serverTimestamp() sentinel, not a value — compare by class.
    expect(stamped.createdAt).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );

    // expiresAt is a real Timestamp at now + 24h.
    expect(stamped.expiresAt).toBeInstanceOf(Timestamp);
    expect(stamped.expiresAt.toMillis()).toBe(1_700_000_000_000 + COMMAND_EXPIRY_MS);
  });

  it('returns a fresh object — does not mutate the caller payload', () => {
    const input: CommandData = { type: 'restart_process' };
    const stamped = stampCommand(input);
    expect(stamped).not.toBe(input);
    expect(input).toEqual({ type: 'restart_process' });
  });

  it('preserves caller fields verbatim', () => {
    const input: CommandData = {
      type: 'install_software',
      installer_url: 'https://example/installer.exe',
      installer_name: 'thing.exe',
      deployment_id: 'dep_abc',
      status: 'pending',
    };
    const stamped = stampCommand(input);
    expect(stamped.type).toBe('install_software');
    expect(stamped.installer_url).toBe('https://example/installer.exe');
    expect(stamped.installer_name).toBe('thing.exe');
    expect(stamped.deployment_id).toBe('dep_abc');
    expect(stamped.status).toBe('pending');
  });

  it('attaches auditCorrelationId when provided', () => {
    const stamped = stampCommand({ type: 'restart_process' }, {
      auditCorrelationId: 'corr_xyz',
    });
    expect(stamped.auditCorrelationId).toBe('corr_xyz');
  });

  it('omits auditCorrelationId when not provided', () => {
    const stamped = stampCommand({ type: 'restart_process' });
    expect(stamped.auditCorrelationId).toBeUndefined();
    // Undefined values break Firestore writes — guard explicitly.
    expect(Object.prototype.hasOwnProperty.call(stamped, 'auditCorrelationId')).toBe(false);
  });

  it('overwrites caller-supplied lifecycle fields', () => {
    // The helper wins over caller-supplied createdAt/expiresAt (stale retries).
    const stamped = stampCommand(
      {
        type: 'restart_process',
        createdAt: 'stale',
        expiresAt: 'stale',
      },
      { now: () => 2_000_000_000_000 },
    );
    expect(stamped.createdAt).not.toBe('stale');
    expect(stamped.expiresAt).toBeInstanceOf(Timestamp);
    expect(stamped.expiresAt.toMillis()).toBe(2_000_000_000_000 + COMMAND_EXPIRY_MS);
  });

  it('uses Date.now() by default', () => {
    const before = Date.now();
    const stamped = stampCommand({ type: 'noop' });
    const after = Date.now();
    const expiresMs = stamped.expiresAt.toMillis();
    expect(expiresMs).toBeGreaterThanOrEqual(before + COMMAND_EXPIRY_MS);
    expect(expiresMs).toBeLessThanOrEqual(after + COMMAND_EXPIRY_MS);
  });
});

// writeCommandFanOut

describe('writeCommandFanOut', () => {
  beforeEach(() => {
    defaultSetMock.mockClear();
  });

  it('writes one map-merge entry per machine to the canonical pending path', async () => {
    const { db, calls } = buildFakeDb();
    const results = await writeCommandFanOut(
      'site_a',
      ['mach-1', 'mach-2', 'mach-3'],
      'restart',
      { type: 'restart_process', process_id: 'p1' },
      { db, now: () => 1_700_000_000_000 },
    );

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toHaveLength(3);

    for (const call of calls) {
      expect(call.path).toEqual([
        'sites',
        'site_a',
        'machines',
        expect.stringMatching(/^mach-[1-3]$/),
        'commands',
        'pending',
      ]);
      expect(call.options).toEqual({ merge: true });
      // Payload is `{ [commandId]: stampedCommandData }` — exactly one key.
      const keys = Object.keys(call.payload);
      expect(keys).toHaveLength(1);
      const commandId = keys[0];
      expect(commandId).toMatch(/^restart_mach_[1-3]_1700000000000$/);
      const entry = call.payload[commandId] as Record<string, unknown>;
      expect(entry.type).toBe('restart_process');
      expect(entry.process_id).toBe('p1');
      expect(entry.expiresAt).toBeInstanceOf(Timestamp);
      expect(entry.createdAt).toBeDefined();
    }
  });

  it('handles a single machine', async () => {
    const { db, calls } = buildFakeDb();
    const results = await writeCommandFanOut(
      'site_a',
      ['only-machine'],
      'kill',
      { type: 'kill_process', process_id: 'p2' },
      { db, now: () => 1_700_000_000_000 },
    );

    expect(results).toEqual([
      { machineId: 'only-machine', ok: true, commandId: 'kill_only_machine_1700000000000' },
    ]);
    expect(calls).toHaveLength(1);
  });

  it('returns an empty array when machineIds is empty', async () => {
    const { db, calls } = buildFakeDb();
    const results = await writeCommandFanOut('site_a', [], 'noop', { type: 'noop' }, { db });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('propagates auditCorrelationId into every machine entry', async () => {
    const { db, calls } = buildFakeDb();
    await writeCommandFanOut(
      'site_a',
      ['m1', 'm2'],
      'install',
      { type: 'install_software' },
      { db, auditCorrelationId: 'corr_42', now: () => 1 },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const [commandId] = Object.keys(call.payload);
      const entry = call.payload[commandId] as Record<string, unknown>;
      expect(entry.auditCorrelationId).toBe('corr_42');
    }
  });

  it('isolates per-machine failures — one bad write does not abort the others', async () => {
    const calls: Array<{ machineId: string }> = [];
    const fakeDb = {
      collection: () => ({
        // First `.doc()` is the site id; not branched on.
        doc: (_siteId: string) => ({
          collection: () => ({
            doc: (machineId: string) => ({
              collection: () => ({
                doc: () => ({
                  set: jest.fn(async () => {
                    calls.push({ machineId });
                    if (machineId === 'bad') {
                      throw new Error('permission_denied');
                    }
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const results = await writeCommandFanOut(
      'site_a',
      ['good-1', 'bad', 'good-2'],
      'restart',
      { type: 'restart_process' },
      { db: fakeDb as unknown as FakeFirestore, now: () => 1 },
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ machineId: 'good-1', ok: true });
    expect(results[1]).toMatchObject({
      machineId: 'bad',
      ok: false,
      error: 'permission_denied',
    });
    expect(results[2]).toMatchObject({ machineId: 'good-2', ok: true });
    expect(calls.map((c) => c.machineId).sort()).toEqual(['bad', 'good-1', 'good-2']);
  });

  it('falls back to getAdminDb() when no db is injected', async () => {
    const results = await writeCommandFanOut(
      'site_a',
      ['mach-only'],
      'kill',
      { type: 'kill_process' },
      { now: () => 7 },
    );
    expect(results).toEqual([
      { machineId: 'mach-only', ok: true, commandId: 'kill_mach_only_7' },
    ]);
    expect(defaultSetMock).toHaveBeenCalledTimes(1);
    const [payload, options] = defaultSetMock.mock.calls[0];
    expect(options).toEqual({ merge: true });
    const [commandId] = Object.keys(payload);
    expect(commandId).toBe('kill_mach_only_7');
  });

  it('rejects a missing siteId', async () => {
    await expect(
      writeCommandFanOut('', ['m1'], 'noop', { type: 'noop' }),
    ).rejects.toThrow('siteId');
  });

  it('rejects a missing commandIdPrefix', async () => {
    await expect(
      writeCommandFanOut('site_a', ['m1'], '', { type: 'noop' }),
    ).rejects.toThrow('commandIdPrefix');
  });

  it('shares one batch timestamp across every machine in the fan-out', async () => {
    const { db, calls } = buildFakeDb();
    await writeCommandFanOut(
      'site_a',
      ['m1', 'm2', 'm3'],
      'install',
      { type: 'install_software' },
      { db, now: () => 1_700_000_000_000 },
    );
    const tsSuffix = '_1700000000000';
    const commandIds = calls.map((c) => Object.keys(c.payload)[0]);
    expect(commandIds.every((id) => id.endsWith(tsSuffix))).toBe(true);
    expect(new Set(commandIds).size).toBe(commandIds.length);
  });
});
