/** @jest-environment node */

/**
 * Talon run engine unit tests.
 *
 * Firestore is an in-memory fake, not `jest.fn()` chains: assertions like "the
 * stale run was closed out AND a fresh run then executed" need real state.
 * Only the side-effecting collaborators are mocked at their module boundary
 * (`@/lib/jobs/talonRunner.server`, the vision check, the mail transport);
 * output recording runs for real through `outputs.server`.
 */

const mockDeleteSentinel = { __fieldValue: 'delete' } as const;
const mockEmitMutation = jest.fn();
const mockDispatchAndAwait = jest.fn();
const mockEvaluateVisualCheck = jest.fn();
const mockGetSiteAlertRecipients = jest.fn();
const mockGetResend = jest.fn();
const mockValidateWebhookUrl = jest.fn();
const mockRunHootOutput = jest.fn();
const mockFetch = jest.fn();

let correlationCounter = 0;

jest.mock('firebase-admin/firestore', () => {
  class FakeTimestamp {
    constructor(readonly ms: number) {}
    toMillis() {
      return this.ms;
    }
  }
  return {
    __esModule: true,
    FieldValue: { delete: () => mockDeleteSentinel, serverTimestamp: () => '__SERVER_TS__' },
    Timestamp: FakeTimestamp,
  };
});
jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  getAdminDb: jest.fn(),
  getAdminAuth: jest.fn(),
}));
jest.mock('@/lib/auditLogClient', () => ({
  __esModule: true,
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/auditLog.server', () => ({
  __esModule: true,
  generateCorrelationId: () => `corr-${++correlationCounter}`,
}));
jest.mock('@/lib/jobs/talonRunner.server', () => ({
  __esModule: true,
  dispatchAndAwait: (...args: unknown[]) => mockDispatchAndAwait(...args),
  dispatchTalonCommand: jest.fn(),
  pollTalonCommandResult: jest.fn(),
}));
jest.mock('@/lib/talons/visualCheck.server', () => {
  class TalonVisualCheckError extends Error {
    readonly code: string;
    readonly disabledReason?: string;
    constructor(code: string, message: string, disabledReason?: string) {
      super(message);
      this.name = 'TalonVisualCheckError';
      this.code = code;
      if (disabledReason) this.disabledReason = disabledReason;
    }
  }
  return {
    __esModule: true,
    TalonVisualCheckError,
    evaluateVisualCheck: (...args: unknown[]) => mockEvaluateVisualCheck(...args),
  };
});
jest.mock('@/lib/adminUtils.server', () => ({
  __esModule: true,
  getSiteAlertRecipients: (...args: unknown[]) => mockGetSiteAlertRecipients(...args),
  recipientWantsMachine: jest.requireActual('@/lib/adminUtils.server').recipientWantsMachine,
}));
jest.mock('@/app/api/unsubscribe/route', () => ({
  __esModule: true,
  generateUnsubscribeToken: (userId: string) => `token-${userId}`,
}));
jest.mock('@/lib/resendClient.server', () => ({
  __esModule: true,
  getResend: () => mockGetResend(),
  FROM_EMAIL: 'Owlette <alerts@example.com>',
  ENV_LABEL: 'DEVELOPMENT',
  isProduction: false,
}));
jest.mock('@/lib/webhookUrl', () => ({
  __esModule: true,
  validateWebhookUrl: (...args: unknown[]) => mockValidateWebhookUrl(...args),
}));
jest.mock('@/lib/hoot-utils.server', () => ({
  __esModule: true,
  resolveLlmConfig: jest.fn(),
  COMMAND_POLL_INTERVAL_MS: 0,
  COMMAND_TIMEOUT_MS: 30000,
}));
// Hoot's detached turn runner is pinned in `hootOutput.test.ts`; mocked here so
// these tests stay about the engine.
jest.mock('@/lib/talons/hootOutput.server', () => ({
  __esModule: true,
  runHootOutput: (...args: unknown[]) => mockRunHootOutput(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import { ExecuteMachineCommandError } from '@/lib/actions/executeMachineCommand.server';
import { runTalon, describeTrigger, STALE_RUN_MS } from '@/lib/talons/engine.server';
import type { StoredTalon } from '@/lib/talons/store.server';
import type { TalonDoc, TalonRunDoc, TalonRunOutput } from '@/lib/talons/types';
import { TalonVisualCheckError } from '@/lib/talons/visualCheck.server';

type DocData = Record<string, unknown>;
type Filter = { field: string; value: unknown };

class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  private idCounter = 0;

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  applyUpdate(path: string, data: DocData): void {
    const current = this.docs.get(path);
    if (!current) throw new Error(`update on missing document ${path}`);
    const next: DocData = { ...current };
    for (const [key, value] of Object.entries(data)) {
      if (value === mockDeleteSentinel) delete next[key];
      else next[key] = value;
    }
    this.docs.set(path, next);
  }

  childPaths(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter(
      (path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  }

  nextId(): string {
    this.idCounter += 1;
    return `generated-${this.idCounter}`;
  }
}

class FakeCollection {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.db, `${this.path}/${id ?? this.db.nextId()}`);
  }

  async add(data: DocData): Promise<FakeDocRef> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.path, [{ field, value }]);
  }

  async get() {
    return new FakeQuery(this.db, this.path, []).get();
  }
}

class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly collectionPath: string,
    private readonly filters: Filter[],
  ) {}

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.db, this.collectionPath, [...this.filters, { field, value }]);
  }

  async get() {
    const docs = this.db
      .childPaths(this.collectionPath)
      .filter((path) => {
        const data = this.db.docs.get(path) ?? {};
        return this.filters.every((filter) => data[filter.field] === filter.value);
      })
      .map((path) => {
        const ref = new FakeDocRef(this.db, path);
        return { id: ref.id, ref, exists: true, data: () => ({ ...this.db.docs.get(path) }) };
      });
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeDocRef {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }

  async get() {
    const data = this.db.docs.get(this.path);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  async set(data: DocData): Promise<void> {
    this.db.docs.set(this.path, { ...data });
  }

  async update(data: DocData): Promise<void> {
    this.db.applyUpdate(this.path, data);
  }
}

const SITE = 'site-a';
const TALONS_PATH = `sites/${SITE}/talons`;
const RUNS_PATH = `sites/${SITE}/talon_runs`;
const LOGS_PATH = `sites/${SITE}/logs`;
const MACHINES_PATH = `sites/${SITE}/machines`;
const NOW = new Date('2026-08-14T12:00:00Z');

let fake: FakeFirestore;
let db: Firestore;

function seedTalon(id: string, overrides: Partial<TalonDoc> = {}): StoredTalon {
  const doc: TalonDoc = {
    schemaVersion: 1,
    name: 'lobby wall check',
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: NOW,
    updatedAt: NOW,
    consecutiveFailures: 0,
    ...overrides,
  };
  fake.docs.set(`${TALONS_PATH}/${id}`, doc as unknown as DocData);
  return { id, ...doc };
}

function seedMachine(id: string, online: boolean, name = id): void {
  fake.docs.set(`${MACHINES_PATH}/${id}`, { name, online });
}

function seedRun(id: string, overrides: Partial<TalonRunDoc>): void {
  fake.docs.set(`${RUNS_PATH}/${id}`, {
    talonId: 't1',
    talonName: 'lobby wall check',
    triggerType: 'schedule',
    triggerSummary: 'every 60 minutes',
    status: 'running',
    startedAt: NOW,
    outputs: [],
    correlationId: 'corr-seed',
    ...overrides,
  } as unknown as DocData);
}

function runDocs(): (TalonRunDoc & { id: string })[] {
  return fake
    .childPaths(RUNS_PATH)
    .map((path) => ({
      id: path.slice(path.lastIndexOf('/') + 1),
      ...(fake.docs.get(path) as unknown as TalonRunDoc),
    }));
}

function logDocs(): DocData[] {
  return fake.childPaths(LOGS_PATH).map((path) => fake.docs.get(path) as DocData);
}

function talonDoc(id: string): TalonDoc {
  return fake.docs.get(`${TALONS_PATH}/${id}`) as unknown as TalonDoc;
}

function outputByType(outputs: TalonRunOutput[], type: string): TalonRunOutput {
  const found = outputs.find((output) => output.type === type);
  if (!found) throw new Error(`no ${type} output recorded`);
  return found;
}

/** A Resend double whose `send` always succeeds. */
function workingResend() {
  const send = jest.fn().mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  return { client: { emails: { send } }, send };
}

beforeEach(() => {
  correlationCounter = 0;
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  fake.docs.set(`sites/${SITE}`, { name: 'lobby', owner: 'owner-uid' });

  // `clearMocks` clears call records only; implementations and queued `*Once`
  // values survive into the next test.
  mockDispatchAndAwait.mockReset();
  mockEvaluateVisualCheck.mockReset();
  mockRunHootOutput.mockResolvedValue({ status: 'sent', chatId: 'talon_1755172800000_r1' });
  mockGetResend.mockReturnValue(null);
  mockGetSiteAlertRecipients.mockResolvedValue([]);
  mockValidateWebhookUrl.mockResolvedValue({
    ok: true,
    url: 'https://hooks.example.com/t',
    hostname: 'hooks.example.com',
  });
  mockFetch.mockResolvedValue({ ok: true, status: 202 });
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('guards', () => {
  it('does not run a disabled talon', async () => {
    const talon = seedTalon('t1', { enabled: false });
    await expect(runTalon(db, talon, { siteId: SITE, now: NOW })).resolves.toEqual([]);
    expect(runDocs()).toHaveLength(0);
  });

  it('skips a threshold talon that is still inside its cooldown', async () => {
    const talon = seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
      cooldownMinutes: 60,
      lastRunAt: new Date(NOW.getTime() - 10 * 60_000),
    });

    await expect(runTalon(db, talon, { siteId: SITE, now: NOW })).resolves.toEqual([]);
    // Deliberately no run record: a hot threshold would bury the real runs.
    expect(runDocs()).toHaveLength(0);
    expect(logDocs()).toHaveLength(0);
  });

  it('runs a threshold talon once the cooldown has elapsed', async () => {
    const talon = seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
      cooldownMinutes: 60,
      lastRunAt: new Date(NOW.getTime() - 61 * 60_000),
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('succeeded');
  });

  it('never applies the cooldown to a schedule trigger', async () => {
    // A schedule already carries its own spacing in `nextRunAt`; applying the
    // (independently configured) cooldown too would silently drop fires.
    const talon = seedTalon('t1', {
      cooldownMinutes: 1440,
      lastRunAt: new Date(NOW.getTime() - 60_000),
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });
    expect(summaries).toHaveLength(1);
  });

  it('records a skipped run when another run is still in flight', async () => {
    const talon = seedTalon('t1');
    seedRun('fresh', { talonId: 't1', status: 'running', startedAt: new Date(NOW.getTime() - 60_000) });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ status: 'skipped', error: 'already_running' });
    // The in-flight run is untouched and no second execution happened.
    expect((fake.docs.get(`${RUNS_PATH}/fresh`) as DocData).status).toBe('running');
    expect(runDocs().filter((run) => run.status === 'succeeded')).toHaveLength(0);
    // Bookkeeping is left to the run that actually holds the slot.
    expect(talonDoc('t1').lastRunAt).toBeUndefined();
  });

  it('takes over a stale run and proceeds', async () => {
    const talon = seedTalon('t1');
    const staleStart = new Date(NOW.getTime() - STALE_RUN_MS - 60_000);
    seedRun('stale', { talonId: 't1', status: 'running', startedAt: staleStart });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    const stale = fake.docs.get(`${RUNS_PATH}/stale`) as DocData;
    expect(stale.status).toBe('failed');
    expect(stale.error).toBe('stale');
    expect(stale.completedAt).toEqual(NOW);

    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('succeeded');
  });

  it('ignores an in-flight run belonging to a different talon', async () => {
    const talon = seedTalon('t1');
    seedRun('other', { talonId: 't2', status: 'running', startedAt: NOW });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });
    expect(summaries[0].status).toBe('succeeded');
  });
});

describe('run recording', () => {
  it('creates a site-level run carrying the trigger summary and correlation id', async () => {
    const talon = seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    const [run] = runDocs();
    expect(run.talonId).toBe('t1');
    expect(run.talonName).toBe('lobby wall check');
    expect(run.triggerType).toBe('threshold');
    expect(run.triggerSummary).toBe('cpu_percent > 90');
    expect(run.correlationId).toBe('corr-1');
    expect(run.status).toBe('succeeded');
    expect(run.completedAt).toEqual(NOW);
    expect(typeof run.durationMs).toBe('number');
    expect(run.machineId).toBeUndefined();
    expect(summaries[0].runId).toBe(run.id);
  });

  it('honors a caller-supplied trigger summary and the manual stamp', async () => {
    const talon = seedTalon('t1');

    await runTalon(db, talon, {
      siteId: SITE,
      now: NOW,
      manual: true,
      triggerSummary: 'manual run',
    });

    const [run] = runDocs();
    expect(run.triggerSummary).toBe('manual run');
    expect(run.manual).toBe(true);
  });

  it('names the machine a machine-specific trigger fired for', async () => {
    const talon = seedTalon('t1', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      cooldownMinutes: 0,
    });
    seedMachine('m1', true, 'LOBBY-01');

    await runTalon(db, talon, { siteId: SITE, now: NOW, machineId: 'm1' });

    const [run] = runDocs();
    expect(run.machineId).toBe('m1');
    expect(run.machineName).toBe('LOBBY-01');
  });

  it('writes companion logs with all four required fields and the site sentinel', async () => {
    const talon = seedTalon('t1');

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    const logs = logDocs();
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      // firestore.rules `hasRequiredFields(['timestamp','action','level','machineId'])`
      // rejects a write missing any one of these outright.
      expect(log.timestamp).toEqual(NOW);
      expect(typeof log.action).toBe('string');
      expect(typeof log.level).toBe('string');
      expect(log.machineId).toBe('site');
      expect(log.machineName).toBe('site');
      expect(typeof log.details).toBe('string');
    }
    expect(logs.map((log) => log.action)).toEqual(['talon_triggered', 'talon_succeeded']);
    expect(logs.map((log) => log.level)).toEqual(['info', 'info']);
  });

  it('logs a failed run at error level', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });
    mockFetch.mockRejectedValue(new Error('socket hang up'));

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    const logs = logDocs();
    expect(logs[1].action).toBe('talon_failed');
    expect(logs[1].level).toBe('error');
  });

  it('carries the machine name into the log for a machine-scoped run', async () => {
    const talon = seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the show loop is playing' },
      scope: { machineIds: ['m1'] },
    });
    seedMachine('m1', true, 'LOBBY-01');
    mockEvaluateVisualCheck.mockResolvedValue({
      verdict: 'pass',
      confidence: 0.94,
      reason: 'the loop is playing',
    });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    const logs = logDocs();
    expect(logs[0].machineId).toBe('m1');
    expect(logs[0].machineName).toBe('LOBBY-01');
  });
});

describe('outputs', () => {
  it('records every output individually, including the webhook http status', async () => {
    const talon = seedTalon('t1', {
      outputs: [
        { type: 'email' },
        { type: 'webhook', url: 'https://hooks.example.com/t' },
        { type: 'cortex', directive: 'investigate the black screen' },
      ],
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });
    const outputs = summaries[0].outputs;

    expect(outputs).toHaveLength(3);
    // No RESEND_API_KEY in this environment — a gate must never read as "sent".
    expect(outputByType(outputs, 'email')).toEqual({
      type: 'email',
      status: 'skipped',
      detail: 'email_transport_unconfigured',
    });
    expect(outputByType(outputs, 'webhook')).toEqual({
      type: 'webhook',
      status: 'sent',
      httpStatus: 202,
    });
    // The hoot output reports the chat its headless turn was dispatched into.
    expect(outputByType(outputs, 'cortex')).toEqual({
      type: 'cortex',
      status: 'sent',
      detail: 'talon_1755172800000_r1',
    });
    // Benign skips do not fail the run.
    expect(summaries[0].status).toBe('succeeded');
    expect(runDocs()[0].outputs).toEqual(outputs);
  });

  it('hands the hoot output the talon, the run, and the trigger summary', async () => {
    const talon = seedTalon('t1', {
      trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
      outputs: [{ type: 'cortex', directive: 'investigate the black screen' }],
    });
    seedMachine('m1', true, 'LOBBY-01');

    const summaries = await runTalon(db, talon, { siteId: SITE, machineId: 'm1', now: NOW });

    expect(mockRunHootOutput).toHaveBeenCalledWith(db, {
      siteId: SITE,
      talon,
      runId: summaries[0].runId,
      correlationId: 'corr-1',
      directive: 'investigate the black screen',
      triggerSummary: 'cpu_percent > 90',
      machineId: 'm1',
      machineName: 'LOBBY-01',
    });
  });

  it('stamps the hoot chat onto the run document', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'cortex', directive: 'investigate the black screen' }],
    });
    mockRunHootOutput.mockResolvedValue({ status: 'sent', chatId: 'talon_42_run-a' });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(runDocs()[0].chatId).toBe('talon_42_run-a');
  });

  it('records the machines a site-wide hoot output could not reach', async () => {
    // The kill switch thinning a fan-out (D-A) has to survive onto the run — an
    // operator reading it afterwards must be able to tell a partial delivery
    // from a complete one, which `sent` plus a chat id alone never said.
    const talon = seedTalon('t1', {
      outputs: [{ type: 'cortex', directive: 'investigate the black screen' }],
    });
    mockRunHootOutput.mockResolvedValue({
      status: 'sent',
      chatId: 'talon_42_run-a',
      skippedMachineIds: ['m2'],
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'cortex')).toEqual({
      type: 'cortex',
      status: 'sent',
      detail: 'talon_42_run-a',
      skippedMachineIds: ['m2'],
    });
    expect(runDocs()[0].outputs).toEqual(summaries[0].outputs);
  });

  it('leaves the run chatId alone when the hoot turn could not be dispatched', async () => {
    // A failed hoot output's `detail` is a reason, not a chat id — stamping it
    // would put a dead link on the run.
    const talon = seedTalon('t1', {
      createdVia: 'cortex',
      chatId: 'authoring-chat',
      outputs: [{ type: 'cortex', directive: 'investigate the black screen' }],
    });
    mockRunHootOutput.mockResolvedValue({
      status: 'failed',
      detail: 'creator_access_revoked',
      error: 'You do not have access to this site',
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'cortex')).toEqual({
      type: 'cortex',
      status: 'failed',
      detail: 'creator_access_revoked',
      error: 'You do not have access to this site',
    });
    expect(summaries[0].status).toBe('failed');
    expect(runDocs()[0].chatId).toBe('authoring-chat');
  });

  it('signs the webhook delivery and re-validates the url at send time', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(mockValidateWebhookUrl).toHaveBeenCalledWith('https://hooks.example.com/t');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Roost-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toMatchObject({
      event: 'talon.fired',
      site: { id: SITE, name: 'lobby' },
    });
  });

  it('fails the webhook output when the send-time url check rejects', async () => {
    // The TOCTOU guard: the store validated this url when the talon was
    // authored, but dns can be repointed at an internal address afterwards.
    mockValidateWebhookUrl.mockResolvedValue({
      ok: false,
      reason: 'private_ip',
      detail: 'hooks.example.com resolves to private ipv4 10.0.0.5',
    });
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'webhook')).toMatchObject({
      status: 'failed',
      detail: 'invalid_webhook_url',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(summaries[0].status).toBe('failed');
  });

  it('emails every unmuted recipient with their own unsubscribe link', async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: ['cc@example.com'], mutedMachines: [] },
      { userId: 'u2', email: 'b@example.com', ccEmails: [], mutedMachines: ['m1'] },
    ]);

    const talon = seedTalon('t1', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      cooldownMinutes: 0,
    });
    seedMachine('m1', true, 'LOBBY-01');

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW, machineId: 'm1' });

    expect(mockGetSiteAlertRecipients).toHaveBeenCalledWith(SITE, 'talonAlerts');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      to: ['a@example.com'],
      cc: ['cc@example.com'],
      subject: 'talon fired: lobby wall check — LOBBY-01',
    });
    expect(send.mock.calls[0][0].html).toContain('token-u1');
    expect(outputByType(summaries[0].outputs, 'email')).toMatchObject({
      status: 'sent',
      detail: 'delivered to 1 recipient(s)',
    });
  });

  it("emails a machine's run only to recipients whose machine scope reaches it", async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [], machineIds: ['m1'] },
      { userId: 'u2', email: 'b@example.com', ccEmails: [], mutedMachines: [], machineIds: ['m2'] },
    ]);

    const talon = seedTalon('t1', {
      trigger: { type: 'event', eventTypes: ['process_crash'] },
      cooldownMinutes: 0,
    });
    seedMachine('m1', true, 'LOBBY-01');

    await runTalon(db, talon, { siteId: SITE, now: NOW, machineId: 'm1' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: ['a@example.com'] });
  });

  it('skips scoped recipients on a site-level run, since they hold nothing site-wide', async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [], machineIds: null },
      { userId: 'u2', email: 'b@example.com', ccEmails: [], mutedMachines: [], machineIds: ['m1'] },
    ]);

    await runTalon(db, seedTalon('t1'), { siteId: SITE, now: NOW });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: ['a@example.com'] });
  });

  it('reports an in-band resend rejection as a failed output', async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'bad domain' } });
    mockGetResend.mockReturnValue({ emails: { send } });
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [] },
    ]);
    const talon = seedTalon('t1');

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'email')).toMatchObject({
      status: 'failed',
      detail: 'send_failed',
    });
    expect(summaries[0].status).toBe('failed');
  });

  it('keeps firing the remaining outputs after one fails', async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [] },
    ]);
    mockValidateWebhookUrl.mockResolvedValue({
      ok: false,
      reason: 'dns_resolve_failed',
      detail: 'hooks.example.com did not resolve',
    });

    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }, { type: 'email' }],
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'webhook').status).toBe('failed');
    expect(outputByType(summaries[0].outputs, 'email').status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('command outputs', () => {
  function commandTalon(): StoredTalon {
    return seedTalon('t1', {
      outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      scope: { machineIds: ['m1'] },
    });
  }

  it('dispatches to the scoped machine and records a success', async () => {
    const talon = commandTalon();
    seedMachine('m1', true);
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'success', result: 'Process restarted' },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(mockDispatchAndAwait).toHaveBeenCalledWith(db, {
      siteId: SITE,
      machineId: 'm1',
      type: 'restart_process',
      payload: { process_name: 'TouchDesigner' },
      correlationId: 'corr-1',
    });
    expect(outputByType(summaries[0].outputs, 'command')).toEqual({
      type: 'command',
      status: 'sent',
      detail: 'ran on 1 machine(s)',
    });
  });

  it('classifies the agent throttle as a benign skip', async () => {
    // The agent's own `{cmd_type}:{process}` 5s window. The command never ran,
    // so the next run can simply try again — this must not fail the talon.
    const talon = commandTalon();
    seedMachine('m1', true);
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: {
        status: 'success',
        result: 'Error: rate limited - restart_process executed too recently, try again in a few seconds',
      },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'command')).toEqual({
      type: 'command',
      status: 'skipped',
      detail: 'agent_rate_limited',
    });
    expect(summaries[0].status).toBe('succeeded');
    expect(talonDoc('t1').consecutiveFailures).toBe(0);
  });

  it('classifies a 409 from the action core as machine_offline', async () => {
    const talon = commandTalon();
    seedMachine('m1', true);
    mockDispatchAndAwait.mockRejectedValue(
      new ExecuteMachineCommandError(409, 'machine_offline', 'machine m1 is currently offline'),
    );

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'command')).toEqual({
      type: 'command',
      status: 'skipped',
      detail: 'machine_offline',
    });
    expect(summaries[0].status).toBe('succeeded');
  });

  it('fails on any other agent error', async () => {
    const talon = commandTalon();
    seedMachine('m1', true);
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'failed', error: 'Error: process TouchDesigner is not configured' },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'command')).toMatchObject({
      status: 'failed',
      detail: 'command_failed',
    });
    expect(summaries[0].status).toBe('failed');
  });

  it('fails when the machine never reports a result', async () => {
    const talon = commandTalon();
    seedMachine('m1', true);
    mockDispatchAndAwait.mockResolvedValue({ status: 'timeout', commandId: 'cmd_1' });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'command')).toMatchObject({
      status: 'failed',
      detail: 'command_timeout',
    });
  });

  it('fans a site-level command output out across every machine in the site', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      scope: { machineIds: null },
    });
    seedMachine('m1', true);
    seedMachine('m2', true);
    mockDispatchAndAwait.mockResolvedValue({
      status: 'completed',
      commandId: 'cmd_1',
      entry: { status: 'success', result: 'Process restarted' },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(mockDispatchAndAwait).toHaveBeenCalledTimes(2);
    expect(outputByType(summaries[0].outputs, 'command')).toEqual({
      type: 'command',
      status: 'sent',
      detail: 'ran on 2 machine(s)',
    });
  });

  it('skips when the talon has no machine left to act on', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'command', commandType: 'stop_process', processName: 'TouchDesigner' }],
      scope: { machineIds: ['gone'] },
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'command')).toEqual({
      type: 'command',
      status: 'skipped',
      detail: 'no_target_machine',
    });
    expect(mockDispatchAndAwait).not.toHaveBeenCalled();
  });
});

describe('visual_check condition', () => {
  function visualTalon(overrides: Partial<TalonDoc> = {}): StoredTalon {
    return seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the show loop is playing' },
      outputs: [{ type: 'email' }],
      scope: { machineIds: ['m1', 'm2'] },
      ...overrides,
    });
  }

  it('runs once per target machine', async () => {
    const talon = visualTalon();
    seedMachine('m1', true, 'LOBBY-01');
    seedMachine('m2', true, 'LOBBY-02');
    mockEvaluateVisualCheck.mockResolvedValue({
      verdict: 'fail',
      confidence: 0.81,
      reason: 'the wall is showing the windows desktop',
      screenshotPath: 'screenshots/site-a/m1/shot.png',
      screenshotUrl: 'https://storage.example.com/signed',
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries.map((summary) => summary.machineId)).toEqual(['m1', 'm2']);
    expect(runDocs()).toHaveLength(2);
    expect(mockEvaluateVisualCheck).toHaveBeenCalledTimes(2);
  });

  it('records the verdict but persists only the storage path', async () => {
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', true);
    mockEvaluateVisualCheck.mockResolvedValue({
      verdict: 'fail',
      confidence: 0.81,
      reason: 'the wall is showing the windows desktop',
      screenshotPath: 'screenshots/site-a/m1/shot.png',
      screenshotUrl: 'https://storage.example.com/signed',
    });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    // Signed capture urls expire in ~1h; a run record outlives them, so the
    // durable reference is the path and the url is never written down.
    expect(runDocs()[0].condition).toEqual({
      type: 'visual_check',
      verdict: 'fail',
      confidence: 0.81,
      reason: 'the wall is showing the windows desktop',
      screenshotPath: 'screenshots/site-a/m1/shot.png',
    });
  });

  it('short-circuits the outputs when the expectation held', async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [] },
    ]);
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', true);
    mockEvaluateVisualCheck.mockResolvedValue({
      verdict: 'pass',
      confidence: 0.97,
      reason: 'the show loop is on screen',
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries[0].status).toBe('succeeded');
    expect(summaries[0].outputs).toEqual([
      { type: 'email', status: 'skipped', detail: 'condition_passed' },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('fires the outputs and embeds the capture when the expectation failed', async () => {
    const { client, send } = workingResend();
    mockGetResend.mockReturnValue(client);
    mockGetSiteAlertRecipients.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com', ccEmails: [], mutedMachines: [] },
    ]);
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', true);
    mockEvaluateVisualCheck.mockResolvedValue({
      verdict: 'fail',
      confidence: 0.81,
      reason: 'the wall is showing the windows desktop',
      screenshotPath: 'screenshots/site-a/m1/shot.png',
      screenshotUrl: 'https://storage.example.com/signed',
    });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(outputByType(summaries[0].outputs, 'email').status).toBe('sent');
    const html = send.mock.calls[0][0].html as string;
    expect(html).toContain('https://storage.example.com/signed');
    expect(html).toContain('the wall is showing the windows desktop');
  });

  it('skips an offline machine without attempting a capture', async () => {
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', false);

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries[0]).toMatchObject({ status: 'skipped', error: 'machine_offline' });
    expect(mockEvaluateVisualCheck).not.toHaveBeenCalled();
    expect(logDocs()[0].action).toBe('talon_skipped');
  });

  it('treats a machine with nobody logged in as a skip, not a failure', async () => {
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', true);
    mockEvaluateVisualCheck.mockRejectedValue(
      new TalonVisualCheckError('no_interactive_session', 'no interactive session available'),
    );

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries[0]).toMatchObject({ status: 'skipped', error: 'no_interactive_session' });
    expect(talonDoc('t1').consecutiveFailures).toBe(0);
  });

  it('fails the run when the verdict could not be produced', async () => {
    const talon = visualTalon({ scope: { machineIds: ['m1'] } });
    seedMachine('m1', true);
    mockEvaluateVisualCheck.mockRejectedValue(
      new TalonVisualCheckError('verdict_error', 'the vision model did not return a verdict'),
    );

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(summaries[0].status).toBe('failed');
    expect(summaries[0].error).toContain('verdict_error');
    expect(talonDoc('t1').consecutiveFailures).toBe(1);
  });
});

describe('talon bookkeeping', () => {
  it('denormalizes the execution onto the talon and resets the failure counter', async () => {
    const talon = seedTalon('t1', { consecutiveFailures: 4 });

    const summaries = await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({
      lastRunAt: NOW,
      lastRunStatus: 'succeeded',
      lastRunId: summaries[0].runId,
      consecutiveFailures: 0,
    });
  });

  it('leaves the failure counter alone on a skipped execution', async () => {
    const talon = seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
      scope: { machineIds: ['m1'] },
      consecutiveFailures: 3,
    });
    seedMachine('m1', false);

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({
      lastRunStatus: 'skipped',
      consecutiveFailures: 3,
    });
    expect(talonDoc('t1').enabled).toBe(true);
  });

  it('reports the worst status across a fan-out execution', async () => {
    const talon = seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
      scope: { machineIds: ['m1', 'm2'] },
    });
    seedMachine('m1', true);
    seedMachine('m2', true);
    mockEvaluateVisualCheck
      .mockResolvedValueOnce({ verdict: 'pass', confidence: 0.9, reason: 'looks right' })
      .mockRejectedValueOnce(new TalonVisualCheckError('capture_failed', 'capture died'));

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1').lastRunStatus).toBe('failed');
    expect(talonDoc('t1').consecutiveFailures).toBe(1);
  });

  it('disables the talon on the tenth consecutive failure and audits the disable', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
      consecutiveFailures: 9,
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({
      enabled: false,
      consecutiveFailures: 10,
      lastRunStatus: 'failed',
      // The backoff states its cause too — a talon found switched off with no
      // reason at all is the thing this field exists to stop.
      disabledReason: 'repeated_failures',
    });
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith({
      kind: 'talon_mutated',
      siteId: SITE,
      actor: 'system:talon_runner',
      targetId: 't1',
      attributes: {
        verb: 'talon.disable',
        endpoint: `/api/sites/${SITE}/talons/t1`,
        method: 'PATCH',
        changedFields: ['enabled', 'disabledReason'],
        reason: 'repeated_failures',
        consecutiveFailures: 10,
      },
    });
  });

  it('does not disable the talon on the ninth failure', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
      consecutiveFailures: 8,
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1').enabled).toBe(true);
    expect(talonDoc('t1').consecutiveFailures).toBe(9);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});

describe('unrecoverable author problems', () => {
  it.each([
    'creator_not_a_user',
    'creator_deleted',
    'creator_access_revoked',
    'creator_missing_llm_key',
  ] as const)('disables on the FIRST %s from a hoot output', async (reason) => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'cortex', directive: 'find out why the wall is black' }],
    });
    mockRunHootOutput.mockResolvedValue({
      status: 'failed',
      detail: reason,
      error: 'the author is gone',
      disabledReason: reason,
    });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    // One failure, not ten: retrying cannot bring a departed author back, so
    // the operator is told now rather than after nine more silent firings.
    expect(talonDoc('t1')).toMatchObject({
      enabled: false,
      consecutiveFailures: 1,
      disabledReason: reason,
    });
    // And the run says so too, so the history explains itself.
    expect(runDocs()[0]).toMatchObject({ status: 'failed', disabledReason: reason });
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          verb: 'talon.disable',
          reason,
          consecutiveFailures: 1,
        }),
      }),
    );
  });

  it('disables on the first author failure from a visual check', async () => {
    const talon = seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
      scope: { machineIds: ['m1'] },
    });
    fake.docs.set(`${MACHINES_PATH}/m1`, { name: 'LOBBY-01', online: true });
    mockEvaluateVisualCheck.mockRejectedValue(
      new TalonVisualCheckError(
        'author_unavailable',
        'author has no usable llm key',
        'creator_missing_llm_key',
      ),
    );

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({
      enabled: false,
      consecutiveFailures: 1,
      disabledReason: 'creator_missing_llm_key',
    });
    expect(runDocs()[0]).toMatchObject({
      status: 'failed',
      disabledReason: 'creator_missing_llm_key',
    });
  });

  it('does NOT disable early for a transient failure', async () => {
    // A provider 500 is the archetype: the next run may well succeed, so it
    // stays on the counter and the talon keeps its enabled state.
    const talon = seedTalon('t1', {
      outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
      consecutiveFailures: 3,
    });
    fake.docs.set(`sites/${SITE}/talon_secrets/t1`, { talonId: 't1', secret: 'whsec_x' });
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({ enabled: true, consecutiveFailures: 4 });
    expect(talonDoc('t1').disabledReason).toBeUndefined();
    expect(runDocs()[0].disabledReason).toBeUndefined();
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('does NOT disable early when a hoot output fails for a transient reason', async () => {
    const talon = seedTalon('t1', {
      outputs: [{ type: 'cortex', directive: 'look' }],
      consecutiveFailures: 3,
    });
    mockRunHootOutput.mockResolvedValue({
      status: 'failed',
      detail: 'turn_lock_failed',
      error: 'another turn holds the lock',
    });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    expect(talonDoc('t1')).toMatchObject({ enabled: true, consecutiveFailures: 4 });
    expect(talonDoc('t1').disabledReason).toBeUndefined();
  });

  it('does NOT disable early for a machine that was simply offline', async () => {
    const talon = seedTalon('t1', {
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
      scope: { machineIds: ['m1'] },
      consecutiveFailures: 2,
    });
    fake.docs.set(`${MACHINES_PATH}/m1`, { name: 'LOBBY-01', online: false });

    await runTalon(db, talon, { siteId: SITE, now: NOW });

    // A skip does not even touch the counter, let alone the enabled flag.
    expect(talonDoc('t1')).toMatchObject({ enabled: true, consecutiveFailures: 2 });
    expect(talonDoc('t1').disabledReason).toBeUndefined();
  });
});

describe('describeTrigger', () => {
  it('describes each trigger shape in lowercase', () => {
    expect(describeTrigger({ type: 'schedule', intervalMinutes: 30 })).toBe('every 30 minutes');
    expect(
      describeTrigger({
        type: 'schedule',
        entries: [{ id: 'e1', days: ['mon', 'wed'], time: '09:00' }],
      }),
    ).toBe('scheduled mon/wed at 09:00');
    expect(
      describeTrigger({
        type: 'schedule',
        entries: [
          { id: 'e1', days: ['mon'], time: '09:00' },
          { id: 'e2', days: ['fri'], time: '17:00' },
        ],
      }),
    ).toBe('scheduled (2 times)');
    expect(
      describeTrigger({ type: 'threshold', metric: 'gpu_temp', operator: '>=', value: 85 }),
    ).toBe('gpu_temp >= 85');
    expect(describeTrigger({ type: 'event', eventTypes: ['process_crash', 'display_drift'] })).toBe(
      'on process_crash, display_drift',
    );
  });

  it('names the wait on a delayed event trigger', () => {
    expect(
      describeTrigger({ type: 'event', eventTypes: ['process_restarted'], delayMinutes: 3 }),
    ).toBe('on process_restarted · after 3 min');
  });

  it('says nothing about a delay that normalized away', () => {
    expect(
      describeTrigger({ type: 'event', eventTypes: ['process_restarted'], delayMinutes: 0 }),
    ).toBe('on process_restarted');
  });
});
