/** @jest-environment node */

/**
 * Unit tests for `web/lib/actions/executeMachineCommand.server.ts`: allowlist
 * enforcement, the plan gate, input validation, machine-doc gating (404/409), command write
 * shape, correlationId propagation, audit payload.
 *
 * Authorization (capability + scope + idempotency) lives in the route shim /
 * `authorizedSiteHandler` and is tested in
 * `web/__tests__/api/sites-machines-commands.test.ts`.
 */

import { FieldValue, Timestamp } from 'firebase-admin/firestore';

// only the plan resolver reads through getAdminDb (the action core takes an
// injected db): the site, for its payer, and the payer's user doc.
const mockAdminCollection = jest.fn((name: string) => ({
  doc: () => ({
    get: async () => ({ data: () => (name === 'sites' ? { owner: 'payer_1' } : { role: 'member' }) }),
  }),
}));
jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => ({ collection: mockAdminCollection }),
}));
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: jest.fn(),
}));
const mockGetEntitlements = jest.fn();
jest.mock('@/lib/tridantEntitlements.server', () => ({
  getEntitlements: (uid: string) => mockGetEntitlements(uid),
}));

import {
  executeMachineCommand,
  ExecuteMachineCommandError,
  ALLOWED_COMMAND_TYPES,
  type ExecuteMachineCommandContext,
} from '@/lib/actions/executeMachineCommand.server';
import { emitMutation } from '@/lib/auditLogClient';
import type { Actor } from '@/lib/capabilities';
import { PLAN_REQUIRED_DETAIL } from '@/lib/plan.server';

const mockedEmit = emitMutation as jest.MockedFunction<typeof emitMutation>;

// fake firestore

interface SetCall {
  path: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}

interface FakeDb {
  setCalls: SetCall[];
  setMachine: (data: Record<string, unknown> | null) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

function buildFakeDb(initialMachine: Record<string, unknown> | null = { online: true }): FakeDb {
  const setCalls: SetCall[] = [];
  let machineData: Record<string, unknown> | null = initialMachine;

  function makeDocRef(docPath: string): unknown {
    return {
      path: docPath,
      collection: (sub: string) => makeCollectionRef(`${docPath}/${sub}`),
      get: async () => {
        // Only the machine doc lookup is exercised by the action core.
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
      set: async (
        payload: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        setCalls.push({ path: docPath, payload, options });
      },
    };
  }

  function makeCollectionRef(colPath: string): unknown {
    return { doc: (id: string) => makeDocRef(`${colPath}/${id}`) };
  }

  const db = { collection: (name: string) => makeCollectionRef(name) };

  return {
    setCalls,
    setMachine: (data) => {
      machineData = data;
    },
    db,
  };
}

const SITE = 'site-alpha';
const MACHINE = 'mach_test_1';

const USER_ACTOR: Actor = {
  type: 'user',
  userId: 'user_42',
  role: 'admin',
  siteRoles: { [SITE]: 'admin' },
};

function ctxFor(overrides: Partial<ExecuteMachineCommandContext> = {}): ExecuteMachineCommandContext {
  return {
    siteId: SITE,
    machineId: MACHINE,
    actor: USER_ACTOR,
    auditActor: 'user:user_42',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// input validation

describe('executeMachineCommand — input validation', () => {
  it('rejects empty siteId', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor({ siteId: '' }),
        { type: 'reboot_machine', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      name: 'ExecuteMachineCommandError',
      status: 400,
      code: 'validation_failed',
    });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('rejects empty machineId', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor({ machineId: '' }),
        { type: 'reboot_machine', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('rejects empty type', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(ctxFor(), { type: '', payload: {} }, { db: fake.db }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(
      executeMachineCommand(ctxFor(), { type: '   ', payload: {} }, { db: fake.db }),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('rejects non-string type', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 123 as any, payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('rejects payload that is not an object', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'reboot_machine', payload: null as any },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(
      executeMachineCommand(
        ctxFor(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'reboot_machine', payload: [1, 2] as any },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(
      executeMachineCommand(
        ctxFor(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'reboot_machine', payload: 'string' as any },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(fake.setCalls).toHaveLength(0);
  });
});

// allowlist enforcement

describe('executeMachineCommand — allowlist', () => {
  it('rejects an unknown command type with 400 unsupported_command_type', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor(),
        { type: 'format_drive', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({
      status: 400,
      code: 'unsupported_command_type',
    });
    expect(fake.setCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  // One pass-through per allowlisted type: only that it clears the gate and
  // reaches the write. Payload normalization is the route shim's job.
  for (const type of [...ALLOWED_COMMAND_TYPES].sort()) {
    it(`accepts ${type} and writes a pending command`, async () => {
      const fake = buildFakeDb();
      const result = await executeMachineCommand(
        ctxFor(),
        { type, payload: {} },
        { db: fake.db, now: () => 1_700_000_000_000 },
      );
      expect(result.commandId).toMatch(/^cmd_/);
      expect(fake.setCalls).toHaveLength(1);
      const call = fake.setCalls[0];
      expect(call.path).toBe(`sites/${SITE}/machines/${MACHINE}/commands/pending`);
      expect(call.options).toEqual({ merge: true });
      const env = call.payload as Record<string, Record<string, unknown>>;
      const cmdId = Object.keys(env)[0];
      expect(env[cmdId].type).toBe(type);
    });
  }

  it('covers the full inventory hit list', () => {
    // A failure here means the allowlist drifted from the route-audit
    // reference and needs a paired update there.
    const expected = [
      'reboot_machine',
      'shutdown_machine',
      'cancel_reboot',
      'dismiss_reboot_pending',
      'capture_screenshot',
      'start_live_view',
      'stop_live_view',
      'restart_process',
      'start_process',
      'stop_process',
      'kill_process',
      'set_launch_mode',
      'apply_display_topology',
      'ack_display_topology',
      'enumerate_display_modes',
      'test_display_apply',
      'mcp_tool_call',
      'cancel_mcp_tool',
      'update_owlette',
    ];
    for (const t of expected) {
      expect(ALLOWED_COMMAND_TYPES.has(t)).toBe(true);
    }
    expect(ALLOWED_COMMAND_TYPES.size).toBe(expected.length);
  });
});

// machine doc gating

describe('executeMachineCommand — machine doc gating', () => {
  it('throws 404 not_found when machine doc is absent', async () => {
    const fake = buildFakeDb(null);
    await expect(
      executeMachineCommand(
        ctxFor(),
        { type: 'reboot_machine', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(fake.setCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('throws 409 machine_offline when machine.online === false', async () => {
    const fake = buildFakeDb({ online: false });
    await expect(
      executeMachineCommand(
        ctxFor(),
        { type: 'reboot_machine', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toMatchObject({ status: 409, code: 'machine_offline' });
    expect(fake.setCalls).toHaveLength(0);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('writes when machine.online is missing (legacy docs without the field)', async () => {
    // `online === false` is the gate; an absent field means online, so legacy
    // pre-heartbeat machine docs still accept commands.
    const fake = buildFakeDb({});
    const result = await executeMachineCommand(
      ctxFor(),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1 },
    );
    expect(result.commandId).toMatch(/^cmd_/);
    expect(fake.setCalls).toHaveLength(1);
  });
});

// command write shape

describe('executeMachineCommand — command write shape', () => {
  it('writes the canonical pending entry with payload + lifecycle stamps', async () => {
    const fake = buildFakeDb();
    const result = await executeMachineCommand(
      ctxFor(),
      {
        type: 'reboot_machine',
        payload: { delay_seconds: 30, timeout_seconds: 60 },
      },
      { db: fake.db, now: () => 1_700_000_000_000 },
    );

    expect(fake.setCalls).toHaveLength(1);
    const call = fake.setCalls[0];
    expect(call.path).toBe(`sites/${SITE}/machines/${MACHINE}/commands/pending`);
    expect(call.options).toEqual({ merge: true });

    const env = call.payload as Record<string, Record<string, unknown>>;
    const keys = Object.keys(env);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(result.commandId);

    const entry = env[result.commandId];
    expect(entry.type).toBe('reboot_machine');
    expect(entry.delay_seconds).toBe(30);
    expect(entry.timeout_seconds).toBe(60);
    expect(entry.siteId).toBe(SITE);
    expect(entry.machineId).toBe(MACHINE);
    expect(entry.status).toBe('pending');
    expect(entry.queuedBy).toBe('user:user_42');

    // Legacy timestamp plus lifecycle stamps from stampCommand.
    expect(entry.timestamp).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.createdAt).toBeInstanceOf(
      Object.getPrototypeOf(FieldValue.serverTimestamp()).constructor,
    );
    expect(entry.expiresAt).toBeInstanceOf(Timestamp);
  });

  it('uses the formatted apiKey:<keyId> auditActor for queuedBy', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor({ auditActor: 'apiKey:key_test_1' }),
      { type: 'capture_screenshot', payload: {} },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.queuedBy).toBe('apiKey:key_test_1');
  });

  it('strips reserved keys from the payload (defense against caller spoofing)', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor(),
      {
        type: 'reboot_machine',
        payload: {
          // Caller-supplied values for reserved keys must be ignored.
          type: 'shutdown_machine',
          status: 'completed',
          queuedBy: 'user:attacker',
          siteId: 'other-site',
          machineId: 'other-machine',
          createdAt: 'fake',
          expiresAt: 'fake',
          auditCorrelationId: 'fake',
          // A non-reserved key passes through.
          delay_seconds: 5,
        },
      },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.type).toBe('reboot_machine');
    expect(entry.status).toBe('pending');
    expect(entry.queuedBy).toBe('user:user_42');
    expect(entry.siteId).toBe(SITE);
    expect(entry.machineId).toBe(MACHINE);
    expect(entry.delay_seconds).toBe(5);
  });

  it('stamps auditCorrelationId when ctx.correlationId is set', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor({ correlationId: 'corr_xyz' }),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.auditCorrelationId).toBe('corr_xyz');
  });

  it('omits auditCorrelationId when ctx.correlationId is not provided', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor(),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(entry, 'auditCorrelationId')).toBe(false);
  });

  it('mints a unique commandId derived from the now() override', async () => {
    const fake = buildFakeDb();
    const a = await executeMachineCommand(
      ctxFor(),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1_700_000_000_000 },
    );
    const b = await executeMachineCommand(
      ctxFor(),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1_700_000_000_001 },
    );
    expect(a.commandId).not.toBe(b.commandId);
    expect(a.commandId.startsWith('cmd_')).toBe(true);
    expect(b.commandId.startsWith('cmd_')).toBe(true);
  });
});

// per-type payload pass-through

describe('executeMachineCommand — per-type payload pass-through', () => {
  it('apply_display_topology forwards layout + applyId', async () => {
    const fake = buildFakeDb();
    const layout = { monitors: [{ id: 1, x: 0, y: 0 }] };
    await executeMachineCommand(
      ctxFor(),
      {
        type: 'apply_display_topology',
        payload: { layout, applyId: 'apply_abc' },
      },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.layout).toEqual(layout);
    expect(entry.applyId).toBe('apply_abc');
  });

  it('ack_display_topology forwards applyId', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor(),
      { type: 'ack_display_topology', payload: { applyId: 'apply_abc' } },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.applyId).toBe('apply_abc');
  });

  it('update_owlette forwards installer_url + checksum + version', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor(),
      {
        type: 'update_owlette',
        payload: {
          installer_url: 'https://example.com/x.exe',
          checksum_sha256: 'abc',
          target_version: '2.11.0',
          deployment_id: 'dep_1',
        },
      },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.installer_url).toBe('https://example.com/x.exe');
    expect(entry.checksum_sha256).toBe('abc');
    expect(entry.target_version).toBe('2.11.0');
    expect(entry.deployment_id).toBe('dep_1');
  });

  it('restart_process / start_process / stop_process / kill_process forward process_id + process_name', async () => {
    for (const type of ['restart_process', 'start_process', 'stop_process', 'kill_process'] as const) {
      const fake = buildFakeDb();
      await executeMachineCommand(
        ctxFor(),
        {
          type,
          payload: { process_id: 'p_1', process_name: 'TouchDesigner.exe' },
        },
        { db: fake.db, now: () => 1 },
      );
      const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
      expect(entry.process_id).toBe('p_1');
      expect(entry.process_name).toBe('TouchDesigner.exe');
      expect(entry.type).toBe(type);
    }
  });

  it('set_launch_mode forwards process_name, mode, and schedules', async () => {
    const fake = buildFakeDb();
    const schedules = [{ days: ['mon'], ranges: [{ start: '09:00', stop: '17:00' }] }];
    await executeMachineCommand(
      ctxFor(),
      {
        type: 'set_launch_mode',
        payload: { process_name: 'TouchDesigner.exe', mode: 'scheduled', schedules },
      },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.process_name).toBe('TouchDesigner.exe');
    expect(entry.mode).toBe('scheduled');
    expect(entry.schedules).toEqual(schedules);
  });

  it('mcp_tool_call forwards hoot tool envelope fields', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(
      ctxFor(),
      {
        type: 'mcp_tool_call',
        payload: {
          tool_name: 'get_system_info',
          tool_params: { verbose: true },
          chat_id: 'chat_1',
          timeout_seconds: 45,
        },
      },
      { db: fake.db, now: () => 1 },
    );
    const entry = Object.values(fake.setCalls[0].payload)[0] as Record<string, unknown>;
    expect(entry.tool_name).toBe('get_system_info');
    expect(entry.tool_params).toEqual({ verbose: true });
    expect(entry.chat_id).toBe('chat_1');
    expect(entry.timeout_seconds).toBe(45);
  });
});

// audit emission

describe('executeMachineCommand — audit emission', () => {
  it('emits machine_command_dispatched with the command type + machine id', async () => {
    const fake = buildFakeDb();
    const result = await executeMachineCommand(
      ctxFor(),
      { type: 'reboot_machine', payload: {} },
      { db: fake.db, now: () => 1 },
    );
    expect(mockedEmit).toHaveBeenCalledTimes(1);
    expect(mockedEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'machine_command_dispatched',
        siteId: SITE,
        actor: 'user:user_42',
        targetId: result.commandId,
        attributes: expect.objectContaining({
          commandType: 'reboot_machine',
          method: 'POST',
          machineId: MACHINE,
        }),
      }),
    );
  });

  it('does not emit when validation fails (no write happened)', async () => {
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(
        ctxFor(),
        { type: 'format_drive', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toThrow(ExecuteMachineCommandError);
    expect(mockedEmit).not.toHaveBeenCalled();
  });

  it('does not emit when machine is offline (no write happened)', async () => {
    const fake = buildFakeDb({ online: false });
    await expect(
      executeMachineCommand(
        ctxFor(),
        { type: 'reboot_machine', payload: {} },
        { db: fake.db },
      ),
    ).rejects.toThrow(ExecuteMachineCommandError);
    expect(mockedEmit).not.toHaveBeenCalled();
  });
});

// plan gate (plan.md decision 7)

describe('executeMachineCommand — plan gate', () => {
  const ENV_KEYS = ['PLAN_ENFORCEMENT', 'TRIDANT_API_URL', 'TRIDANT_LICENSE_KEY'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  const FREE = {
    ok: true,
    resolved: false,
    standing: 'expired',
    inGoodStanding: false,
    ent: { 'owlette.machines': '1', 'owlette.sites': '1', 'owlette.control': '0', 'owlette.hoot': '0' },
    epoch: 0,
  };
  const CORE = { ...FREE, resolved: true, standing: 'active', ent: { ...FREE.ent, 'owlette.control': '1' } };
  const PLAN_FREE_TYPES = ['update_owlette', 'cancel_reboot', 'dismiss_reboot_pending', 'stop_live_view', 'cancel_mcp_tool'];

  function enforce(): void {
    process.env.PLAN_ENFORCEMENT = 'on';
    process.env.TRIDANT_API_URL = 'https://tridant.test';
    process.env.TRIDANT_LICENSE_KEY = 'test-key';
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockGetEntitlements.mockResolvedValue(FREE);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('enforcement off: queues a gated type without reading anything for the plan', async () => {
    const fake = buildFakeDb();
    await executeMachineCommand(ctxFor(), { type: 'reboot_machine', payload: {} }, { db: fake.db });
    expect(fake.setCalls).toHaveLength(1);
    expect(mockGetEntitlements).not.toHaveBeenCalled();
    expect(mockAdminCollection).not.toHaveBeenCalled();
  });

  for (const type of [...ALLOWED_COMMAND_TYPES].filter((t) => !PLAN_FREE_TYPES.includes(t)).sort()) {
    it(`free: refuses ${type} with 402 plan_required and writes nothing`, async () => {
      enforce();
      const fake = buildFakeDb();
      // hoot's tool calls are hoot's (pro); every other gated type is control (core).
      const entitlement = type === 'mcp_tool_call' ? 'owlette.hoot' : 'owlette.control';
      await expect(
        executeMachineCommand(ctxFor(), { type, payload: {} }, { db: fake.db }),
      ).rejects.toMatchObject({
        name: 'ExecuteMachineCommandError',
        status: 402,
        code: 'plan_required',
        detail: PLAN_REQUIRED_DETAIL[entitlement],
        entitlement,
      });
      expect(mockGetEntitlements).toHaveBeenCalledWith('payer_1');
      expect(fake.setCalls).toHaveLength(0);
      expect(mockedEmit).not.toHaveBeenCalled();
    });
  }

  for (const type of PLAN_FREE_TYPES) {
    it(`free: still queues ${type}`, async () => {
      enforce();
      const fake = buildFakeDb();
      const result = await executeMachineCommand(ctxFor(), { type, payload: {} }, { db: fake.db });
      expect(result.commandId).toMatch(/^cmd_/);
      expect(fake.setCalls).toHaveLength(1);
      expect(mockGetEntitlements).not.toHaveBeenCalled();
    });
  }

  it('core: queues a control type', async () => {
    enforce();
    mockGetEntitlements.mockResolvedValue(CORE);
    const fake = buildFakeDb();
    await executeMachineCommand(ctxFor(), { type: 'reboot_machine', payload: {} }, { db: fake.db });
    expect(fake.setCalls).toHaveLength(1);
  });

  it('core: refuses a hoot tool call on owlette.hoot', async () => {
    enforce();
    mockGetEntitlements.mockResolvedValue(CORE);
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(ctxFor(), { type: 'mcp_tool_call', payload: {} }, { db: fake.db }),
    ).rejects.toMatchObject({ status: 402, code: 'plan_required', entitlement: 'owlette.hoot' });
    expect(fake.setCalls).toHaveLength(0);
  });

  it('pro: queues a hoot tool call', async () => {
    enforce();
    mockGetEntitlements.mockResolvedValue({ ...CORE, ent: { ...CORE.ent, 'owlette.hoot': '1' } });
    const fake = buildFakeDb();
    await executeMachineCommand(ctxFor(), { type: 'mcp_tool_call', payload: {} }, { db: fake.db });
    expect(fake.setCalls).toHaveLength(1);
  });

  it('fails open when tridant is unreachable', async () => {
    enforce();
    mockGetEntitlements.mockResolvedValue({ ok: false, reason: 'unreachable' });
    const fake = buildFakeDb();
    await executeMachineCommand(ctxFor(), { type: 'reboot_machine', payload: {} }, { db: fake.db });
    expect(fake.setCalls).toHaveLength(1);
  });

  it('validates the input before resolving the plan', async () => {
    enforce();
    const fake = buildFakeDb();
    await expect(
      executeMachineCommand(ctxFor(), { type: 'format_drive', payload: {} }, { db: fake.db }),
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_command_type' });
    expect(mockGetEntitlements).not.toHaveBeenCalled();
  });
});
