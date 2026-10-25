/** @jest-environment node */

/**
 * Conversational talon tools. `create_talon` / `list_talons` /
 * `set_talon_enabled` never reach an agent — they call
 * `@/lib/talons/store.server`, which owns every rule and has its own suite, so
 * it is mocked here. What the tool layer owns: writes at tier 2 (members are
 * capped at tier 1 by `resolveHootMaxTier`) and the read at tier 1; a store
 * context naming the HUMAN driving
 * the chat with `via: 'cortex'` and the authoring chat id; `command` outputs
 * refused for non-admins; store rejections (notably the pro gate) returned as a
 * tool RESULT, never thrown; lowercase copy that says "hoot", never "cortex".
 */

// Mocks

jest.mock('ai', () => ({
  tool: jest.fn((opts: unknown) => opts),
  jsonSchema: jest.fn((s: unknown) => s),
}));

jest.mock('@/lib/llm-encryption.server', () => ({
  decryptApiKey: jest.fn((v: string) => v),
}));

// firestoreTime.server reads `Timestamp` at module load; a stub suffices since
// the fixtures use Date.
jest.mock('firebase-admin/firestore', () => ({
  Timestamp: class Timestamp {},
  FieldValue: { delete: jest.fn(() => '__FIELD_DELETE__') },
}));

jest.mock('@/lib/actions/createProcess.server', () => {
  class ActionInputError extends Error {}
  return { ActionInputError, createProcess: jest.fn() };
});

jest.mock('@/lib/actions/updateProcess.server', () => ({ updateProcess: jest.fn() }));
jest.mock('@/lib/actions/deleteProcess.server', () => ({ deleteProcess: jest.fn() }));

jest.mock('@/lib/processConfig.server', () => {
  class ProcessConfigError extends Error {}
  return { ProcessConfigError };
});

const mockCreateTalon = jest.fn();
const mockListTalons = jest.fn();
const mockSetTalonEnabled = jest.fn();

jest.mock('@/lib/talons/store.server', () => {
  // Same name and three fields, so `talonErrorResult`'s instanceof branch hits.
  class TalonStoreError extends Error {
    readonly status: number;
    readonly code: string;
    readonly fieldErrors?: { field: string; code: string; message: string }[];

    constructor(
      status: number,
      code: string,
      message: string,
      fieldErrors?: { field: string; code: string; message: string }[],
    ) {
      super(message);
      this.name = 'TalonStoreError';
      this.status = status;
      this.code = code;
      if (fieldErrors) this.fieldErrors = fieldErrors;
    }
  }

  return {
    TalonStoreError,
    createTalon: (...args: unknown[]) => mockCreateTalon(...args),
    listTalons: (...args: unknown[]) => mockListTalons(...args),
    setTalonEnabled: (...args: unknown[]) => mockSetTalonEnabled(...args),
  };
});

import { buildExecutableTools, type BuildExecutableToolsOptions } from '@/lib/hoot-utils.server';
import { getToolByName, getToolsByTier } from '@/lib/mcp-tools';
import { TalonStoreError } from '@/lib/talons/store.server';

// Fixtures

const TALON_TOOL_NAMES = ['create_talon', 'list_talons', 'set_talon_enabled'] as const;

const SITE = 'site-a';
const CHAT = 'chat-77';

/** Sentinel — executors hand the db straight to the mocked store. */
const db = { __db: 'sentinel' } as unknown as FirebaseFirestore.Firestore;

// `userSiteRole` is the standing that grants; `userRole` is the global tier and
// confers nothing on a site. Omitting the former denies every site-scoped tool,
// which is the correct default but not what these fixtures mean.
const ADMIN: BuildExecutableToolsOptions = {
  userId: 'uid_alice',
  userRole: 'admin',
  userSiteRole: 'admin',
};
const MEMBER: BuildExecutableToolsOptions = {
  userId: 'uid_bob',
  userRole: 'member',
  userSiteRole: 'member',
};

/** The store context a chat-authored talon must be written with. */
const adminStoreContext = {
  siteId: SITE,
  actor: { type: 'user', userId: 'uid_alice', role: 'admin', siteRoles: { [SITE]: 'admin' } },
  auditActor: 'cortex:user_uid_alice',
  via: 'cortex',
  chatId: CHAT,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function talonTools(options: BuildExecutableToolsOptions = ADMIN): Record<string, any> {
  return buildExecutableTools(
    db,
    SITE,
    'm1',
    CHAT,
    TALON_TOOL_NAMES.map((name) => getToolByName(name)!),
    false,
    [],
    options,
  );
}

function talonInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nightly check',
    trigger: { type: 'schedule', intervalMinutes: 60 },
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

const storedTalon = {
  id: 'tal_1',
  name: 'nightly check',
  enabled: true,
  trigger: { type: 'schedule', intervalMinutes: 60 },
  outputs: [{ type: 'email' }],
  nextRunAt: new Date('2026-08-20T09:00:00.000Z'),
};

beforeEach(() => {
  mockCreateTalon.mockReset();
  mockListTalons.mockReset();
  mockSetTalonEnabled.mockReset();
});

// Tool definitions

describe('talon tool definitions', () => {
  it.each(['create_talon', 'set_talon_enabled'])('%s is tier 2 — site admins change automations, members do not', (name) => {
    expect(getToolByName(name)?.tier).toBe(2);
    expect(getToolsByTier(2).map((t) => t.name)).toContain(name);
    // Members cap at tier 1, so a talon WRITE leaking into tier 1 would let every
    // member arm, disarm or author the site's automations.
    expect(getToolsByTier(1).map((t) => t.name)).not.toContain(name);
  });

  it('list_talons is tier 1 — members already read every talon on their site', () => {
    // This was tier 2 on the grounds that a member seeing the site's automations
    // was a leak. It isn't one: the rules let any site member read
    // `sites/{siteId}/talons` (firestore.rules, `match /talons/{talonId}`,
    // `allow read: if canAccessSite(siteId)`), and the talons page lists them all
    // through `useTalons`. Hiding the read from a member's hoot only kept hoot
    // from checking whether a talon is about to act on a machine before it acts.
    expect(getToolByName('list_talons')?.tier).toBe(1);
    expect(getToolsByTier(1).map((t) => t.name)).toContain('list_talons');
  });

  it('create_talon tells the model to confirm the shape and never invent machine ids', () => {
    const description = getToolByName('create_talon')!.description;
    expect(description).toMatch(/confirm/i);
    expect(description).toMatch(/never invent/i);
    expect(description).toMatch(/lowercase/i);
    expect(description).toMatch(/20 talons per site/i);
    expect(description).toMatch(/15 minutes minimum when the condition is a visual_check/i);
  });

  it('create_talon takes the validator input shape', () => {
    const tool = getToolByName('create_talon')!;
    expect(Object.keys(tool.parameters.properties)).toEqual([
      'name',
      'description',
      'trigger',
      'condition',
      'outputs',
      'scope',
      'cooldownMinutes',
      'enabled',
    ]);
    expect(tool.parameters.required).toEqual(['name', 'trigger', 'outputs']);
  });

  it('list_talons takes no parameters and set_talon_enabled takes both of its own', () => {
    expect(getToolByName('list_talons')!.parameters.properties).toEqual({});
    expect(getToolByName('set_talon_enabled')!.parameters.required).toEqual([
      'talon_id',
      'enabled',
    ]);
  });
});

// create_talon

describe('create_talon', () => {
  it('writes through the store as the human, via hoot, with the chat id', async () => {
    mockCreateTalon.mockResolvedValue(storedTalon);
    const input = talonInput();

    const result = await talonTools().create_talon.execute(input);

    expect(mockCreateTalon).toHaveBeenCalledWith(db, adminStoreContext, input);
    expect(result).toEqual({
      ok: true,
      talon_id: 'tal_1',
      name: 'nightly check',
      enabled: true,
      next_run_at: '2026-08-20T09:00:00.000Z',
      message: 'created talon "nightly check".',
    });
  });

  it('result copy is lowercase and never names hoot', async () => {
    mockCreateTalon.mockResolvedValue({ ...storedTalon, enabled: false });

    const result = await talonTools().create_talon.execute(talonInput({ enabled: false }));
    const message = (result as { message: string }).message;

    expect(message).toBe('created talon "nightly check", left disabled.');
    expect(message).not.toMatch(/hoot/i);
    // Nothing outside the quoted talon name may be capitalized.
    expect(message.replace(/"[^"]*"/g, '')).toBe(message.replace(/"[^"]*"/g, '').toLowerCase());
  });

  it('lets an explicit options.chatId override the positional one', async () => {
    mockCreateTalon.mockResolvedValue(storedTalon);

    await talonTools({ ...ADMIN, chatId: 'chat-explicit' }).create_talon.execute(talonInput());

    expect(mockCreateTalon).toHaveBeenCalledWith(
      db,
      { ...adminStoreContext, chatId: 'chat-explicit' },
      expect.anything(),
    );
  });

  it('refuses a command output from a non-admin without touching the store', async () => {
    const result = await talonTools(MEMBER).create_talon.execute(
      talonInput({
        outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'command_output_forbidden',
      detail:
        'only site admins can give a talon a command output — an email, webhook, or hoot directive output is available instead.',
      status: 403,
    });
    expect(mockCreateTalon).not.toHaveBeenCalled();
  });

  it('lets a site admin author a command output', async () => {
    mockCreateTalon.mockResolvedValue(storedTalon);

    const result = await talonTools().create_talon.execute(
      talonInput({
        outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      }),
    );

    expect(result).toMatchObject({ ok: true, talon_id: 'tal_1' });
    expect(mockCreateTalon).toHaveBeenCalledTimes(1);
  });

  it('returns the pro gate as a tool result instead of throwing', async () => {
    mockCreateTalon.mockRejectedValue(
      new TalonStoreError(403, 'pro_required', 'this feature requires the pro tier.'),
    );

    // A throw would abort the turn; the model needs an explainable result.
    await expect(talonTools().create_talon.execute(talonInput())).resolves.toEqual({
      ok: false,
      error: 'pro_required',
      detail: 'this feature requires the pro tier.',
      status: 403,
    });
  });

  it('passes the validator field errors back so the model can correct itself', async () => {
    const fieldErrors = [
      {
        field: 'trigger.intervalMinutes',
        code: 'out_of_range',
        message: 'runs at most every 5 minutes',
      },
    ];
    mockCreateTalon.mockRejectedValue(
      new TalonStoreError(400, 'invalid_talon', fieldErrors[0].message, fieldErrors),
    );

    const result = await talonTools().create_talon.execute(
      talonInput({ trigger: { type: 'schedule', intervalMinutes: 1 } }),
    );

    expect(result).toEqual({
      ok: false,
      error: 'invalid_talon',
      detail: fieldErrors[0].message,
      status: 400,
      field_errors: fieldErrors,
    });
  });

  it('reports an unexpected store failure as a result too', async () => {
    mockCreateTalon.mockRejectedValue(new Error('firestore is unavailable'));

    await expect(talonTools().create_talon.execute(talonInput())).resolves.toEqual({
      ok: false,
      error: 'internal_error',
      detail: 'firestore is unavailable',
    });
  });
});

// list_talons

describe('list_talons', () => {
  it('summarizes the site talons', async () => {
    mockListTalons.mockResolvedValue([
      {
        ...storedTalon,
        lastRunStatus: 'succeeded',
        lastRunAt: new Date('2026-08-19T09:00:00.000Z'),
      },
      {
        id: 'tal_2',
        name: 'wall watchdog',
        enabled: false,
        trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
        outputs: [{ type: 'email' }, { type: 'cortex', directive: 'restart td' }],
      },
    ]);

    const result = await talonTools().list_talons.execute({});

    expect(mockListTalons).toHaveBeenCalledWith(db, SITE);
    expect(result).toEqual({
      ok: true,
      count: 2,
      talons: [
        {
          talon_id: 'tal_1',
          name: 'nightly check',
          enabled: true,
          trigger: { type: 'schedule', intervalMinutes: 60 },
          outputs: ['email'],
          last_run_status: 'succeeded',
          last_run_at: '2026-08-19T09:00:00.000Z',
          next_run_at: '2026-08-20T09:00:00.000Z',
        },
        {
          talon_id: 'tal_2',
          name: 'wall watchdog',
          enabled: false,
          trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
          outputs: ['email', 'cortex'],
          last_run_status: null,
          last_run_at: null,
          next_run_at: null,
        },
      ],
    });
  });

  it('reports a store failure as a result', async () => {
    mockListTalons.mockRejectedValue(new Error('firestore is unavailable'));

    await expect(talonTools().list_talons.execute({})).resolves.toMatchObject({
      ok: false,
      error: 'internal_error',
    });
  });
});

// set_talon_enabled

describe('set_talon_enabled', () => {
  it('flips the talon through the store with the human actor', async () => {
    mockSetTalonEnabled.mockResolvedValue({ ...storedTalon, enabled: false, nextRunAt: undefined });

    const result = await talonTools().set_talon_enabled.execute({
      talon_id: '  tal_1  ',
      enabled: false,
    });

    expect(mockSetTalonEnabled).toHaveBeenCalledWith(db, adminStoreContext, 'tal_1', false);
    expect(result).toEqual({
      ok: true,
      talon_id: 'tal_1',
      name: 'nightly check',
      enabled: false,
      next_run_at: null,
      message: 'disabled talon "nightly check".',
    });
  });

  it.each([
    ['a missing talon_id', { enabled: true }, 'missing_talon_id'],
    ['a blank talon_id', { talon_id: '   ', enabled: true }, 'missing_talon_id'],
    ['a non-boolean enabled', { talon_id: 'tal_1', enabled: 'yes' }, 'invalid_enabled'],
  ])('rejects %s without calling the store', async (_label, params, code) => {
    const result = await talonTools().set_talon_enabled.execute(params);

    expect(result).toMatchObject({ ok: false, error: code, status: 400 });
    expect(mockSetTalonEnabled).not.toHaveBeenCalled();
  });

  it('returns an unknown talon as a result', async () => {
    mockSetTalonEnabled.mockRejectedValue(
      new TalonStoreError(404, 'talon_not_found', 'talon `tal_9` was not found.'),
    );

    await expect(
      talonTools().set_talon_enabled.execute({ talon_id: 'tal_9', enabled: true }),
    ).resolves.toEqual({
      ok: false,
      error: 'talon_not_found',
      detail: 'talon `tal_9` was not found.',
      status: 404,
    });
  });
});
