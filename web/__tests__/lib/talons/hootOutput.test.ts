/** @jest-environment node */

/**
 * Unit tests for the hoot output — the headless assistant turn a talon fires.
 * Only the three outside collaborators are mocked (author pre-flight, turn
 * store, detached runner); everything this module decides runs for real.
 *
 * `author.server` keeps `requireActual` so the REAL `TalonAuthorError` is in
 * play — this module classifies on `instanceof`, and a stand-in would keep
 * passing after the real class moved. `Date.now` is pinned so the chatId is
 * assertable verbatim.
 *
 * `hoot-utils.server` is deliberately NOT mocked either: the pre-flights run
 * against seeded machine documents — one for a machine-scoped run, the whole
 * `machines` collection for a site-wide one — so the defaults they lean on (an
 * absent doc is offline, an absent `online` is offline, an absent
 * `cortexEnabled` is on) are the real ones.
 */

const mockResolveTalonAuthor = jest.fn();
const mockAssertTalonAuthorLlmKey = jest.fn();
const mockStartTurn = jest.fn();
const mockAcquireTurnLock = jest.fn();
const mockCancel = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  __esModule: true,
  FieldValue: { serverTimestamp: () => '__SERVER_TS__' },
  Timestamp: class {},
}));
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/talons/author.server', () => ({
  ...jest.requireActual('@/lib/talons/author.server'),
  __esModule: true,
  resolveTalonAuthor: (...args: unknown[]) => mockResolveTalonAuthor(...args),
  assertTalonAuthorLlmKey: (...args: unknown[]) => mockAssertTalonAuthorLlmKey(...args),
}));
jest.mock('@/lib/hoot/turnRunner.server', () => ({
  __esModule: true,
  startTurn: (...args: unknown[]) => mockStartTurn(...args),
}));
jest.mock('@/lib/hoot/turnStore.server', () => ({
  __esModule: true,
  acquireTurnLock: (...args: unknown[]) => mockAcquireTurnLock(...args),
  generateTurnId: () => 'turn_fixed',
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import type { StartTurnParams } from '@/lib/hoot/turnRunner.server';
import { TalonAuthorError } from '@/lib/talons/author.server';
import {
  READ_ONLY_TIER,
  runHootOutput,
  UNATTENDED_MAX_TIER,
  unattendedToolTier,
  type RunHootOutputArgs,
} from '@/lib/talons/hootOutput.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc } from '@/lib/talons/types';

const SITE = 'site-a';
const RUN_ID = 'run-1';
/** 2026-08-14T12:00:00Z — pinned so the chatId is deterministic. */
const NOW_MS = Date.parse('2026-08-14T12:00:00Z');
const EXPECTED_CHAT_ID = `talon_${NOW_MS}_${RUN_ID}`;

type DocData = Record<string, unknown>;

/**
 * Just enough Firestore for `chats/{chatId}.set(...)`, the machine pre-flight's
 * `sites/{siteId}/machines/{machineId}.get()`, and the site-wide pre-flight's
 * `sites/{siteId}/machines.get()`. Seeded docs live in their own map so `docs`
 * stays a record of what this module WROTE — the refusal tests assert it never
 * grows.
 */
class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  readonly seeded = new Map<string, DocData>();
  setError: Error | null = null;
  getError: Error | null = null;

  collection(name: string) {
    return this.collectionAt(name);
  }

  private collectionAt(path: string) {
    return {
      doc: (id: string) => {
        const docPath = `${path}/${id}`;
        return {
          set: async (data: DocData) => {
            if (this.setError) throw this.setError;
            this.docs.set(docPath, { ...data });
          },
          get: async () => {
            if (this.getError) throw this.getError;
            const data = this.seeded.get(docPath) ?? this.docs.get(docPath);
            return { exists: data !== undefined, data: () => data };
          },
          collection: (sub: string) => this.collectionAt(`${docPath}/${sub}`),
        };
      },
      // Collection read: the immediate children of `path`, seeded winning over
      // written, mirroring the document getter's precedence.
      get: async () => {
        if (this.getError) throw this.getError;
        const merged = new Map([...this.docs, ...this.seeded]);
        const prefix = `${path}/`;
        const docs = [...merged.entries()]
          .filter(([docPath]) => docPath.startsWith(prefix) && !docPath.slice(prefix.length).includes('/'))
          .map(([docPath, data]) => ({ id: docPath.slice(prefix.length), data: () => data }));
        return { docs };
      },
    };
  }
}

/**
 * The presence doc a pre-flight reads — `m1` is the machine-scoped target. It
 * heartbeats now: a flag with no fresh heartbeat reads offline, as on the dashboard.
 */
function seedMachine(data: DocData, machineId = 'm1'): void {
  fake.seeded.set(`sites/${SITE}/machines/${machineId}`, { lastHeartbeat: Math.floor(NOW_MS / 1000), ...data });
}

let fake: FakeFirestore;
let db: Firestore;

function talonFixture(overrides: Partial<TalonDoc> = {}): StoredTalon {
  const doc: TalonDoc = {
    schemaVersion: 1,
    name: 'lobby wall check',
    enabled: true,
    trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
    condition: { type: 'none' },
    outputs: [{ type: 'cortex', directive: 'find out why the wall is black' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: new Date(NOW_MS),
    updatedAt: new Date(NOW_MS),
    consecutiveFailures: 0,
    ...overrides,
  };
  return { id: 't1', ...doc };
}

function args(overrides: Partial<RunHootOutputArgs> = {}): RunHootOutputArgs {
  return {
    siteId: SITE,
    talon: talonFixture(),
    runId: RUN_ID,
    correlationId: 'corr-1',
    directive: 'find out why the wall is black',
    triggerSummary: 'cpu_percent > 90',
    machineId: 'm1',
    machineName: 'LOBBY-01',
    ...overrides,
  };
}

function chatDoc(): DocData | undefined {
  return fake.docs.get(`chats/${EXPECTED_CHAT_ID}`);
}

function startTurnParams(): StartTurnParams {
  return mockStartTurn.mock.calls[0][1] as StartTurnParams;
}

/** The text of the synthetic user message the turn opens with. */
function directiveText(): string {
  const [message] = startTurnParams().messages;
  const [part] = message.parts as { type: string; text: string }[];
  return part.text;
}

beforeEach(() => {
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  jest.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  // Online, and no `cortexEnabled` field — the kill switch defaults to on.
  seedMachine({ online: true });

  mockResolveTalonAuthor.mockResolvedValue({
    userId: 'admin-uid',
    access: {
      role: 'admin',
      isSuperadmin: false,
      isSiteAdmin: true,
      isSiteOwner: true,
    },
  });
  mockAssertTalonAuthorLlmKey.mockResolvedValue(undefined);
  mockAcquireTurnLock.mockResolvedValue(null);
  mockCancel.mockResolvedValue(undefined);
  mockStartTurn.mockReturnValue({ cancel: mockCancel });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fire-time access re-resolution', () => {
  it('re-resolves the creator against the site on every run', async () => {
    await runHootOutput(db, args());

    expect(mockResolveTalonAuthor).toHaveBeenCalledWith(db, SITE, args().talon);
  });

  // Every unrecoverable author problem. Each must fail the run AND carry
  // `disabledReason` — without it a disable is unexplainable after the fact.
  it.each([
    ['creator_not_a_user', 'Talon t1 has no user author'],
    ['creator_deleted', 'Talon t1 author admin-uid can no longer run it: User is deleted'],
    ['creator_access_revoked', 'Talon t1 author admin-uid can no longer run it: no access'],
  ] as const)('disables the talon immediately on %s', async (reason, message) => {
    mockResolveTalonAuthor.mockRejectedValue(new TalonAuthorError(reason, message));

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: reason,
      error: message,
      disabledReason: reason,
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    // No chat either: a conversation nobody is allowed to have must not exist.
    expect(fake.docs.size).toBe(0);
  });

  it('disables the talon immediately when the creator has no llm key', async () => {
    mockAssertTalonAuthorLlmKey.mockRejectedValue(
      new TalonAuthorError('creator_missing_llm_key', 'Talon author admin-uid has no usable llm key'),
    );

    const result = await runHootOutput(db, args());

    expect(result).toMatchObject({
      status: 'failed',
      detail: 'creator_missing_llm_key',
      disabledReason: 'creator_missing_llm_key',
    });
    // Pre-flighted before the chat and the lock, so a keyless creator leaves no
    // empty conversation or claimed lock behind on every firing.
    expect(mockAssertTalonAuthorLlmKey).toHaveBeenCalledWith(db, 'admin-uid');
    expect(fake.docs.size).toBe(0);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('leaves a transient author-check failure on the failure counter', async () => {
    // A Firestore outage is NOT a TalonAuthorError, and must never disable a
    // talon — the database being unreachable says nothing about the author.
    mockResolveTalonAuthor.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'author_check_failed',
      error: 'DEADLINE_EXCEEDED',
    });
    expect(result).not.toHaveProperty('disabledReason');
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('machine pre-flight', () => {
  // Every tool the turn can call is relayed to the agent, so an unreachable or
  // opted-out machine must refuse BEFORE a chat, a lock, or a runner exists.
  it.each([
    ['the machine is offline', { online: false }, 'machine_offline'],
    ['the machine has no presence doc', null, 'machine_offline'],
    ['hoot is switched off on the machine', { online: true, cortexEnabled: false }, 'hoot_disabled'],
  ])('skips without dispatching when %s', async (_label, machine, detail) => {
    if (machine === null) fake.seeded.clear();
    else seedMachine(machine);

    const result = await runHootOutput(db, args());

    // `skipped`, not `failed`: nothing is wrong with the talon, so this must
    // never spend one of the ten runs that auto-disable it.
    expect(result).toEqual({ status: 'skipped', detail });
    expect(fake.docs.size).toBe(0);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('dispatches when the machine is online and the kill switch is on', async () => {
    seedMachine({ online: true, cortexEnabled: true });

    const result = await runHootOutput(db, args());

    expect(result).toEqual({ status: 'sent', chatId: EXPECTED_CHAT_ID });
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
  });

  it('leaves a failed machine read on the failure counter', async () => {
    // A read that failed says nothing about the machine, so it is neither a
    // benign skip nor grounds to disable anything.
    fake.getError = new Error('DEADLINE_EXCEEDED');

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'machine_check_failed',
      error: 'DEADLINE_EXCEEDED',
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('still disables the talon when the author is gone AND the machine is offline', async () => {
    // Ordering is deliberate: the author check is terminal and runs first, so a
    // machine that happens to be down cannot postpone the disable indefinitely.
    seedMachine({ online: false });
    mockResolveTalonAuthor.mockRejectedValue(
      new TalonAuthorError('creator_deleted', 'Talon t1 author admin-uid can no longer run it'),
    );

    const result = await runHootOutput(db, args());

    expect(result).toMatchObject({
      status: 'failed',
      detail: 'creator_deleted',
      disabledReason: 'creator_deleted',
    });
  });
});

describe('site-wide pre-flight', () => {
  /** A site-wide run: no machineId, so the whole site is the target. */
  function siteArgs(): RunHootOutputArgs {
    return args({ machineId: undefined, machineName: undefined });
  }

  // `/api/hoot` refuses site mode with nothing online; without the same check
  // here the turn runner throws INSIDE an already-locked turn, leaving an empty
  // chat and a claimed lock behind on every firing.
  it.each([
    ['no machine in the site is online', () => seedMachine({ online: false, cortexEnabled: true }, 'm2')],
    ['the site has no machines at all', () => fake.seeded.clear()],
  ])('skips without dispatching when %s', async (_label, seed) => {
    fake.seeded.clear();
    seed();

    const result = await runHootOutput(db, siteArgs());

    // `skipped`, not `failed`: a sleeping site is not a talon fault, so it must
    // never spend one of the ten runs that auto-disable it.
    expect(result).toEqual({ status: 'skipped', detail: 'no_machines_online' });
    expect(fake.docs.size).toBe(0);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('dispatches when one machine is online and the rest are not', async () => {
    // The gate is "somewhere to run", not "everywhere" — the runner fans each
    // tool call out to whichever machines are online at the time.
    seedMachine({ online: false });
    seedMachine({ online: true }, 'm2');

    const result = await runHootOutput(db, siteArgs());

    expect(result).toEqual({ status: 'sent', chatId: EXPECTED_CHAT_ID });
    expect(mockStartTurn).toHaveBeenCalledTimes(1);
  });

  it('drops a hoot-off machine from the set a site run fans out over', async () => {
    // D-A: the kill switch is honoured on EVERY dispatch, site-wide talons
    // included. `m2` is online and would have received every relayed tool call
    // before this; now it is skipped, and the turn carries which machine it lost
    // so the model can say so rather than quietly answering for a smaller fleet.
    fake.seeded.clear();
    seedMachine({ online: true });
    seedMachine({ online: true, cortexEnabled: false }, 'm2');

    const result = await runHootOutput(db, siteArgs());

    // The held-back machine travels back to the caller, which records it on the
    // run: a fan-out that reached 1 of 2 machines must not read as a complete
    // delivery once the turn is over.
    expect(result).toEqual({
      status: 'sent',
      chatId: EXPECTED_CHAT_ID,
      skippedMachineIds: ['m2'],
    });
    expect(startTurnParams().resolved).toEqual({
      ids: ['m1'],
      fanOut: true,
      skipped: { offline: [], disabled: ['m2'] },
    });
  });

  it('records no skipped list when the kill switch held nothing back', async () => {
    // `toStrictEqual`: the field must be ABSENT, not present-and-undefined — a
    // run that reached everything says nothing about skipping.
    fake.seeded.clear();
    seedMachine({ online: true });
    seedMachine({ online: true }, 'm2');

    const result = await runHootOutput(db, siteArgs());

    expect(result).toStrictEqual({ status: 'sent', chatId: EXPECTED_CHAT_ID });
  });

  it('skips without dispatching when every online machine has hoot switched off', async () => {
    // `skipped`, not `failed`: an operator pausing hoot across the site is a
    // deliberate act, and must not spend one of the ten runs that auto-disable
    // the talon. Refusing here also keeps the empty chat and the claimed lock
    // from being written for a turn with nothing to talk to.
    fake.seeded.clear();
    seedMachine({ online: true, cortexEnabled: false });
    seedMachine({ online: true, cortexEnabled: false }, 'm2');

    const result = await runHootOutput(db, siteArgs());

    expect(result).toEqual({ status: 'skipped', detail: 'no_hoot_enabled_machines' });
    expect(fake.docs.size).toBe(0);
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('reports a sleeping site as offline even when its machines also have hoot off', async () => {
    // Offline is classified first: "nobody is home" must never read back as
    // "somebody switched hoot off", or the suggested fix is the wrong one.
    fake.seeded.clear();
    seedMachine({ online: false, cortexEnabled: false });

    const result = await runHootOutput(db, siteArgs());

    expect(result).toEqual({ status: 'skipped', detail: 'no_machines_online' });
  });

  it('leaves a failed site read on the failure counter', async () => {
    // Classified exactly like the machine guards' failed read: transient, and it
    // decides nothing about the site.
    fake.getError = new Error('DEADLINE_EXCEEDED');

    const result = await runHootOutput(db, siteArgs());

    expect(result).toEqual({
      status: 'failed',
      detail: 'machine_check_failed',
      error: 'DEADLINE_EXCEEDED',
    });
    expect(fake.docs.size).toBe(0);
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('still disables the talon when the author is gone AND the site is asleep', async () => {
    // Same ordering rule as the machine path: the author check is terminal and
    // runs first, so an empty site cannot postpone the disable indefinitely.
    fake.seeded.clear();
    mockResolveTalonAuthor.mockRejectedValue(
      new TalonAuthorError('creator_deleted', 'Talon t1 author admin-uid can no longer run it'),
    );

    const result = await runHootOutput(db, siteArgs());

    expect(result).toMatchObject({
      status: 'failed',
      detail: 'creator_deleted',
      disabledReason: 'creator_deleted',
    });
  });
});

describe('the chat', () => {
  it('creates a fresh chat keyed by timestamp and run id', async () => {
    const result = await runHootOutput(db, args());

    expect(result).toEqual({ status: 'sent', chatId: EXPECTED_CHAT_ID });
    expect(chatDoc()).toEqual({
      source: 'talon',
      siteId: SITE,
      userId: 'admin-uid',
      targetType: 'machine',
      // The new list plus the legacy trio, written together by
      // `chatTargetFields` so an old tab reading `targetMachineId` narrows to
      // this machine instead of widening to the site.
      targetMachineIds: ['m1'],
      targetMachineId: 'm1',
      machineName: 'LOBBY-01',
      title: 'talon: lobby wall check',
      talonId: 't1',
      runId: RUN_ID,
      correlationId: 'corr-1',
      messages: [],
      createdAt: '__SERVER_TS__',
      updatedAt: '__SERVER_TS__',
    });
  });

  it('creates the chat before claiming the lock, so the runner treats the turn as a continuation', async () => {
    await runHootOutput(db, args());

    // Doc-exists is the runner's new-conversation signal; with the chat already
    // written, its placeholder title can never overwrite `talon: …`.
    expect(chatDoc()).toBeDefined();
    expect(mockAcquireTurnLock).toHaveBeenCalledWith(db, EXPECTED_CHAT_ID, {
      turnId: 'turn_fixed',
      siteId: SITE,
      machineId: 'm1',
      // The record carries the turn's target from the moment it is claimed, so a
      // later approval resume has an explicit list to bind to.
      target: { machineIds: ['m1'], fanOut: false, source: 'talon' },
      resolvedMachineIds: ['m1'],
    });
  });

  it('goes site-wide when the run names no machine', async () => {
    await runHootOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(chatDoc()).toMatchObject({
      targetType: 'site',
      targetMachineIds: null,
      targetMachineId: null,
      machineName: 'All Machines',
    });
    // The turn fans out over the online machines; no `chatTarget`, so the
    // runner cannot overwrite the friendly label written above.
    expect(startTurnParams()).toMatchObject({
      resolved: { ids: ['m1'], fanOut: true },
      turnTarget: { machineIds: null, fanOut: true, source: 'talon' },
    });
    expect(startTurnParams().chatTarget).toBeUndefined();
  });

  it('keeps the machine display name as the chat label', async () => {
    // A talon machine chat is labelled `LOBBY-01`, not `m1`: `machineName` is
    // what the sidebar, the header and both sides of a share read, and the
    // run carries the friendly name the engine already resolved.
    await runHootOutput(db, args({ machineName: 'LOBBY-01' }));

    expect(chatDoc()).toMatchObject({ targetMachineIds: ['m1'], machineName: 'LOBBY-01' });
  });

  it('labels the chat with the machine id when the run carries no display name', async () => {
    await runHootOutput(db, args({ machineName: undefined }));

    expect(chatDoc()).toMatchObject({ targetMachineIds: ['m1'], machineName: 'm1' });
  });

  it('fails without a lock or a turn when the chat cannot be written', async () => {
    fake.setError = new Error('permission denied');

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'chat_create_failed',
      error: 'permission denied',
    });
    expect(mockAcquireTurnLock).not.toHaveBeenCalled();
    expect(mockStartTurn).not.toHaveBeenCalled();
  });

  it('fails without a turn when the lock cannot be claimed', async () => {
    mockAcquireTurnLock.mockRejectedValue(new Error('a turn is already running'));

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_lock_failed',
      error: 'a turn is already running',
    });
    expect(mockStartTurn).not.toHaveBeenCalled();
  });
});

describe('the turn', () => {
  it('starts headless with the run identifiers, the talon source, and the recovery index', async () => {
    // The lock returns the whole prior turn record; only its recovery index is
    // threaded into the runner here.
    mockAcquireTurnLock.mockResolvedValue({
      toolCommands: { call_1: { m1: { commandId: 'cmd_1' } } },
      fanOut: false,
      resolvedMachineIds: ['m1'],
      messageId: null,
      pendingApprovals: [],
    });

    await runHootOutput(db, args());

    expect(startTurnParams()).toMatchObject({
      chatId: EXPECTED_CHAT_ID,
      turnId: 'turn_fixed',
      siteId: SITE,
      resolved: { ids: ['m1'], fanOut: false },
      turnTarget: { machineIds: ['m1'], fanOut: false, source: 'talon' },
      userId: 'admin-uid',
      source: 'talon',
      priorTurn: { toolCommands: { call_1: { m1: { commandId: 'cmd_1' } } } },
    });
  });

  it('cancels the unread http tee branch immediately', async () => {
    // The runner returns the HTTP branch of a tee; unread, it buffers the whole
    // turn in memory. The snapshot pump owns the other branch.
    await runHootOutput(db, args());

    expect(mockCancel).toHaveBeenCalledTimes(1);
  });

  it('still reports sent when cancelling the branch rejects', async () => {
    mockCancel.mockRejectedValue(new Error('already errored'));

    await expect(runHootOutput(db, args())).resolves.toEqual({
      status: 'sent',
      chatId: EXPECTED_CHAT_ID,
    });
  });

  it('records a failure rather than throwing when the runner cannot be started', async () => {
    mockStartTurn.mockImplementation(() => {
      throw new Error('stream setup failed');
    });

    const result = await runHootOutput(db, args());

    expect(result).toEqual({
      status: 'failed',
      detail: 'turn_start_failed',
      error: 'stream setup failed',
    });
  });

});

describe('privilege ceiling', () => {
  it('caps a turn at read-only tools by default', async () => {
    mockResolveTalonAuthor.mockResolvedValue({
      userId: 'admin-uid',
      access: {
        role: 'superadmin',
        isSuperadmin: true,
        isSiteAdmin: true,
        isSiteOwner: true,
      },
    });

    await runHootOutput(db, args());

    // The ceiling is explicit, not laundered through a degraded access object —
    // `startTurn` intersects it with what the access earns.
    expect(startTurnParams().maxToolTier).toBe(READ_ONLY_TIER);
    expect(startTurnParams().access).toEqual({
      role: 'superadmin',
      isSuperadmin: true,
      isSiteAdmin: true,
      isSiteOwner: true,
    });
  });

  it('raises the ceiling to tier 2 when the output opted into acting', async () => {
    await runHootOutput(db, args({ allowActions: true }));

    expect(startTurnParams().maxToolTier).toBe(UNATTENDED_MAX_TIER);
  });

  it('never reaches tier 3, whatever the opt-in says', () => {
    // Tier-3 tools (powershell, file writes, deploys, reboots) can require an
    // in-chat approval, and nobody is in this conversation to grant one.
    expect(unattendedToolTier(true)).toBeLessThan(3);
    expect(unattendedToolTier(false)).toBeLessThan(3);
    expect(UNATTENDED_MAX_TIER).toBe(2);
  });
});

describe('the directive message', () => {
  it('opens with the directive and names the talon, trigger, and machine', async () => {
    await runHootOutput(db, args());

    const [message] = startTurnParams().messages;
    expect(message).toMatchObject({ id: `talon_msg_${RUN_ID}`, role: 'user' });

    const text = directiveText();
    expect(text.startsWith('find out why the wall is black')).toBe(true);
    expect(text).toContain('- talon: lobby wall check');
    expect(text).toContain('- trigger: cpu_percent > 90');
    expect(text).toContain('- machine: LOBBY-01 (m1)');
  });

  it('says the scope is the whole site when no machine is named', async () => {
    await runHootOutput(db, args({ machineId: undefined, machineName: undefined }));

    expect(directiveText()).toContain('- scope: every machine in this site');
  });

  it('carries the reason and screenshot from a failed visual check', async () => {
    await runHootOutput(
      db,
      args({
        condition: {
          type: 'visual_check',
          verdict: 'fail',
          confidence: 0.91,
          reason: 'the wall is showing the windows desktop',
          screenshotPath: 'screenshots/site-a/m1/abc.png',
          screenshotUrl: 'https://storage.example.com/abc.png?sig=1',
        },
      }),
    );

    const text = directiveText();
    expect(text).toContain('- visual check: failed — the wall is showing the windows desktop');
    expect(text).toContain('- screenshot: https://storage.example.com/abc.png?sig=1');
  });

  it('omits the visual check block when the condition passed', async () => {
    // The engine only fires outputs on a failed check, but a `pass` reaching
    // here must never be described to the model as something to react to.
    await runHootOutput(
      db,
      args({
        condition: { type: 'visual_check', verdict: 'pass', reason: 'the loop is playing' },
      }),
    );

    expect(directiveText()).not.toContain('visual check');
  });
});
