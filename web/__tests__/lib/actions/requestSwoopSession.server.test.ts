/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/requestSwoopSession.server.ts`.
 *
 * The load-bearing case is `command document carries nothing but an opaque sid`:
 * every site member can read `commands/pending`, so a deep key comparison per
 * type is what keeps a bundle, token, key, TURN credential or signalling url out
 * of that document — a future field addition fails these tests.
 *
 * Authorization (capability, step-up, api-key refusal) lives in the Wave 3 route
 * and `authorizedSiteHandler`, not here.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: () => ({ doc: () => ({}) }) }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));

import {
  requestSwoopSession,
  RequestSwoopSessionError,
  SWOOP_COMMAND_TYPES,
  type RequestSwoopSessionInput,
  type SwoopCommandType,
} from '@/lib/actions/requestSwoopSession.server';
import {
  executeMachineCommand,
  ALLOWED_COMMAND_TYPES,
} from '@/lib/actions/executeMachineCommand.server';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

// fake firestore

interface SetCall {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface FakeDb {
  setCalls: SetCall[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(machineData: Record<string, unknown> | null = { online: true }): FakeDb {
  const setCalls: SetCall[] = [];

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        if (
          docPath.startsWith('sites/') &&
          docPath.includes('/machines/') &&
          !docPath.includes('/commands/')
        ) {
          if (machineData === null) return { exists: false, data: () => undefined };
          return { exists: true, data: () => machineData };
        }
        return { exists: false, data: () => undefined };
      },
      set: async (payload: Record<string, unknown>, options?: { merge?: boolean }) => {
        setCalls.push({ path: docPath, payload, options });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return { doc: (id: string) => makeDocRef(`${colPath}/${id}`) };
  }

  return { setCalls, db: { collection: (name: string) => makeCollectionRef(name) } };
}

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';
const SID = 'swp_9f3a2b1c4d5e6f70';

const USER_ACTOR: Actor = {
  type: 'user',
  userId: 'user_42',
  role: 'admin',
  siteRoles: { [SITE]: 'admin' },
};

function inputFor(overrides: Partial<RequestSwoopSessionInput> = {}): RequestSwoopSessionInput {
  return {
    type: 'swoop_session_requested',
    sid: SID,
    siteId: SITE,
    machineId: MACHINE,
    actor: USER_ACTOR,
    auditActor: 'user:user_42',
    ...overrides,
  };
}

/** The single command entry written by one call. */
function writtenEntry(fake: FakeDb): Record<string, unknown> {
  expect(fake.setCalls).toHaveLength(1);
  const entries = Object.values(fake.setCalls[0].payload);
  expect(entries).toHaveLength(1);
  return entries[0] as Record<string, unknown>;
}

const ENVELOPE_KEYS = [
  'type',
  'siteId',
  'machineId',
  'timestamp',
  'status',
  'queuedBy',
  'createdAt',
  'expiresAt',
];

beforeEach(() => {
  jest.clearAllMocks();
});

// the sid-only contract

describe('requestSwoopSession — the command document carries nothing but an opaque sid', () => {
  // A deep key comparison per type: any field added to the document in future,
  // by any caller, fails here.
  const cases: ReadonlyArray<{
    name: string;
    input: Partial<RequestSwoopSessionInput>;
    expectedKeys: string[];
  }> = [
    {
      name: 'swoop_session_requested carries sid',
      input: { type: 'swoop_session_requested', sid: SID },
      expectedKeys: [...ENVELOPE_KEYS, 'sid'],
    },
    {
      name: 'swoop_kill with a sid carries it',
      input: { type: 'swoop_kill', sid: SID },
      expectedKeys: [...ENVELOPE_KEYS, 'sid'],
    },
    {
      name: 'swoop_kill without a sid carries no sid key',
      input: { type: 'swoop_kill', sid: undefined },
      expectedKeys: [...ENVELOPE_KEYS],
    },
    {
      name: 'swoop_refresh carries no sid key at all',
      input: { type: 'swoop_refresh', sid: undefined },
      expectedKeys: [...ENVELOPE_KEYS],
    },
  ];

  for (const c of cases) {
    it(`${c.name} — exact key set`, async () => {
      const fake = buildFakeDb();
      await requestSwoopSession(inputFor(c.input), { db: fake.db, now: () => 1_700_000_000_000 });
      const entry = writtenEntry(fake);
      expect(Object.keys(entry).sort()).toEqual([...c.expectedKeys].sort());
    });
  }

  it('adds only auditCorrelationId when a correlationId is supplied', async () => {
    const fake = buildFakeDb();
    await requestSwoopSession(inputFor({ correlationId: 'corr_xyz' }), {
      db: fake.db,
      now: () => 1,
    });
    const entry = writtenEntry(fake);
    expect(Object.keys(entry).sort()).toEqual(
      [...ENVELOPE_KEYS, 'sid', 'auditCorrelationId'].sort(),
    );
    expect(entry.auditCorrelationId).toBe('corr_xyz');
  });

  it('every string value in the document is a known non-secret — no bundle, jwt, key, turn credential or url', async () => {
    const fake = buildFakeDb();
    await requestSwoopSession(inputFor({ correlationId: 'corr_xyz' }), {
      db: fake.db,
      now: () => 1,
    });
    const entry = writtenEntry(fake);
    const allowedStrings = new Set([
      'swoop_session_requested',
      SID,
      SITE,
      MACHINE,
      'pending',
      'user:user_42',
      'corr_xyz',
    ]);
    for (const [key, value] of Object.entries(entry)) {
      if (typeof value === 'string') {
        expect(allowedStrings).toContain(value);
      } else {
        // the only non-strings are the lifecycle stamps
        expect(['timestamp', 'createdAt', 'expiresAt']).toContain(key);
      }
    }
  });

  it('refuses a sid that is not an opaque id (a jwt, a url or a blob cannot ride in it)', async () => {
    for (const badSid of [
      'eyJhbGciOiJFZERTQSJ9.eyJzaWQiOiJ4In0.sig',
      'https://swoop-signal.example.com/v1/session/abc',
      '{"bundle":1}',
      'a'.repeat(129),
      '',
    ]) {
      const fake = buildFakeDb();
      await expect(
        requestSwoopSession(inputFor({ sid: badSid }), { db: fake.db }),
      ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
      expect(fake.setCalls).toHaveLength(0);
    }
  });
});

// write shape + canonical envelope

describe('requestSwoopSession — write shape', () => {
  it('writes to commands/pending keyed by the minted command id, merging', async () => {
    const fake = buildFakeDb();
    const result = await requestSwoopSession(inputFor(), {
      db: fake.db,
      now: () => 1_700_000_000_000,
    });
    expect(result.commandId).toMatch(/^cmd_/);
    const call = fake.setCalls[0];
    expect(call.path).toBe(`sites/${SITE}/machines/${MACHINE}/commands/pending`);
    expect(call.options).toEqual({ merge: true });
    expect(Object.keys(call.payload)).toEqual([result.commandId]);
  });

  it('stamps the canonical envelope and the lifecycle fields', async () => {
    const fake = buildFakeDb();
    await requestSwoopSession(inputFor({ auditActor: 'user:user_42' }), {
      db: fake.db,
      now: () => 1_700_000_000_000,
    });
    const entry = writtenEntry(fake);
    expect(entry.type).toBe('swoop_session_requested');
    expect(entry.sid).toBe(SID);
    expect(entry.siteId).toBe(SITE);
    expect(entry.machineId).toBe(MACHINE);
    expect(entry.status).toBe('pending');
    expect(entry.queuedBy).toBe('user:user_42');
    expect(entry.timestamp).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.createdAt).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.expiresAt).toBeInstanceOf(Timestamp);
  });

  it('writes each of the three swoop types successfully', async () => {
    for (const type of SWOOP_COMMAND_TYPES) {
      const fake = buildFakeDb();
      const result = await requestSwoopSession(
        inputFor({ type, sid: type === 'swoop_refresh' ? undefined : SID }),
        { db: fake.db, now: () => 1 },
      );
      expect(result.commandId).toMatch(/^cmd_/);
      expect(writtenEntry(fake).type).toBe(type);
    }
  });
});

// per-type sid rules

describe('requestSwoopSession — per-type sid rules', () => {
  it('requires a sid for swoop_session_requested', async () => {
    const fake = buildFakeDb();
    await expect(
      requestSwoopSession(inputFor({ sid: undefined }), { db: fake.db }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('accepts swoop_kill with or without a sid', async () => {
    for (const sid of [SID, undefined]) {
      const fake = buildFakeDb();
      await requestSwoopSession(inputFor({ type: 'swoop_kill', sid }), {
        db: fake.db,
        now: () => 1,
      });
      expect(writtenEntry(fake).sid).toBe(sid);
    }
  });

  it('refuses a sid on swoop_refresh — an enablement toggle names no session', async () => {
    const fake = buildFakeDb();
    await expect(
      requestSwoopSession(inputFor({ type: 'swoop_refresh', sid: SID }), { db: fake.db }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });
});

// type gating

describe('requestSwoopSession — type gating', () => {
  it('rejects a non-swoop type with 400 unsupported_command_type', async () => {
    for (const type of ['reboot_machine', 'capture_screenshot', 'format_drive', '']) {
      const fake = buildFakeDb();
      await expect(
        requestSwoopSession(inputFor({ type: type as SwoopCommandType }), { db: fake.db }),
      ).rejects.toMatchObject({ status: 400, code: 'unsupported_command_type' });
      expect(fake.setCalls).toHaveLength(0);
      expect(mockedEmit).not.toHaveBeenCalled();
    }
  });

  it('rejects an empty siteId or machineId before touching firestore', async () => {
    for (const override of [{ siteId: '' }, { machineId: '' }]) {
      const fake = buildFakeDb();
      await expect(
        requestSwoopSession(inputFor(override), { db: fake.db }),
      ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
      expect(fake.setCalls).toHaveLength(0);
    }
  });
});

// the two command surfaces stay disjoint

describe('swoop types are unreachable from the generic commands action', () => {
  it('no swoop_* type is in ALLOWED_COMMAND_TYPES', () => {
    for (const type of SWOOP_COMMAND_TYPES) {
      expect(ALLOWED_COMMAND_TYPES.has(type)).toBe(false);
    }
    expect([...ALLOWED_COMMAND_TYPES].filter((t) => t.startsWith('swoop'))).toEqual([]);
  });

  it('executeMachineCommand rejects every swoop type with unsupported_command_type', async () => {
    for (const type of SWOOP_COMMAND_TYPES) {
      const fake = buildFakeDb();
      await expect(
        executeMachineCommand(
          {
            siteId: SITE,
            machineId: MACHINE,
            actor: USER_ACTOR,
            auditActor: 'user:user_42',
          },
          { type, payload: { sid: SID } },
          { db: fake.db },
        ),
      ).rejects.toMatchObject({ status: 400, code: 'unsupported_command_type' });
      expect(fake.setCalls).toHaveLength(0);
    }
  });
});

// machine doc gating

describe('requestSwoopSession — machine doc gating', () => {
  it('throws 404 not_found when the machine doc is absent', async () => {
    const fake = buildFakeDb(null);
    await expect(requestSwoopSession(inputFor(), { db: fake.db })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    expect(fake.setCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('throws 409 machine_offline for swoop_session_requested', async () => {
    const fake = buildFakeDb({ online: false });
    await expect(requestSwoopSession(inputFor(), { db: fake.db })).rejects.toMatchObject({
      status: 409,
      code: 'machine_offline',
    });
    expect(fake.setCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('queues swoop_kill anyway when the machine is offline', async () => {
    const fake = buildFakeDb({ online: false });
    const result = await requestSwoopSession(inputFor({ type: 'swoop_kill' }), {
      db: fake.db,
      now: () => 1,
    });
    expect(result.commandId).toMatch(/^cmd_/);
    expect(writtenEntry(fake).type).toBe('swoop_kill');
  });

  it('writes when machine.online is missing (legacy docs without the field)', async () => {
    const fake = buildFakeDb({});
    await requestSwoopSession(inputFor(), { db: fake.db, now: () => 1 });
    expect(fake.setCalls).toHaveLength(1);
  });
});

// audit emission

describe('requestSwoopSession — audit emission', () => {
  it('emits machine_command_dispatched once, carrying no sid or secret', async () => {
    const fake = buildFakeDb();
    const result = await requestSwoopSession(inputFor(), { db: fake.db, now: () => 1 });
    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith({
      kind: 'machine_command_dispatched',
      siteId: SITE,
      actor: 'user:user_42',
      targetId: result.commandId,
      attributes: { commandType: 'swoop_session_requested', machineId: MACHINE },
    });
  });

  it('does not emit when the write did not happen', async () => {
    const fake = buildFakeDb({ online: false });
    await expect(requestSwoopSession(inputFor(), { db: fake.db })).rejects.toThrow(
      RequestSwoopSessionError,
    );
    expect(mockedEmit).not.toHaveBeenCalled();
  });
});
