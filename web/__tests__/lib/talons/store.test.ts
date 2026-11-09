/** @jest-environment node */

/**
 * Unit tests for the talon store.
 *
 * Firestore is an in-memory fake rather than `jest.fn()` chains: the store
 * writes two collections, reads back through batches, and deletes fields with
 * a `FieldValue.delete()` sentinel, so assertions like "the secret is in
 * talon_secrets and nowhere else" or "nextRunAt was removed, not nulled" need
 * real state. `firebase-admin/firestore` is mocked to `FieldValue` alone, and
 * `@/lib/firebase-admin` stubbed, so the real Admin SDK never loads.
 */

const mockDeleteSentinel = { __fieldValue: 'delete' } as const;
const mockEmitMutation = jest.fn();
const mockAssertLlmKeyAvailable = jest.fn();
const mockValidateWebhookUrl = jest.fn();
const mockCapabilityCheck = jest.fn();

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => mockDeleteSentinel },
}));
jest.mock('@/lib/firebase-admin', () => ({ getAdminAuth: jest.fn(), getAdminDb: jest.fn() }));
// the real check, recording each actor it is asked about: the successor's actor
// never leaves the store any other way.
jest.mock('@/lib/capabilities', () => {
  const actual = jest.requireActual('@/lib/capabilities');
  return {
    ...actual,
    hasCapability: (...args: unknown[]) => {
      mockCapabilityCheck(...args);
      return actual.hasCapability(...args);
    },
  };
});
jest.mock('@/lib/auditLogClient', () => ({
  emitMutation: (...args: unknown[]) => mockEmitMutation(...args),
}));
jest.mock('@/lib/hoot-utils.server', () => ({
  assertLlmKeyAvailable: (...args: unknown[]) => mockAssertLlmKeyAvailable(...args),
}));
jest.mock('@/lib/webhookUrl', () => ({
  validateWebhookUrl: (...args: unknown[]) => mockValidateWebhookUrl(...args),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Firestore } from 'firebase-admin/firestore';
import {
  Capability,
  hasCapability,
  machineScopeOf,
  type Actor,
  type UserActor,
} from '@/lib/capabilities';
import {
  TalonStoreError,
  countTalonsAuthoredBy,
  createTalon,
  deleteTalon,
  getTalon,
  listTalons,
  listTalonsAuthoredBy,
  listTalonsAuthoredByAcrossSites,
  reassignTalons,
  setTalonEnabled,
  updateTalon,
  type TalonStoreContext,
  type TalonStoreErrorCode,
} from '@/lib/talons/store.server';
import { MAX_TALONS_PER_SITE } from '@/lib/talons/validation';
import type { TalonDoc } from '@/lib/talons/types';

// In-memory Firestore

type DocData = Record<string, unknown>;
type BatchOp = { kind: 'set' | 'update' | 'delete'; path: string; data?: DocData };

class FakeFirestore {
  readonly docs = new Map<string, DocData>();
  private idCounter = 0;

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  collectionGroup(id: string): FakeCollectionGroup {
    return new FakeCollectionGroup(this, id);
  }

  /**
   * Batched read. `loadSuccessorActor` fetches the successor's user document and
   * their membership row together — the successor's authority is per-site, so
   * both are needed to decide whether they may inherit a talon.
   */
  getAll(...refs: FakeDocRef[]) {
    return Promise.all(refs.map((ref) => ref.get()));
  }

  batch() {
    const ops: BatchOp[] = [];
    return {
      set: (ref: FakeDocRef, data: DocData) => ops.push({ kind: 'set', path: ref.path, data }),
      update: (ref: FakeDocRef, data: DocData) =>
        ops.push({ kind: 'update', path: ref.path, data }),
      delete: (ref: FakeDocRef) => ops.push({ kind: 'delete', path: ref.path }),
      commit: async () => {
        for (const op of ops) {
          if (op.kind === 'set') this.docs.set(op.path, { ...op.data });
          else if (op.kind === 'delete') this.docs.delete(op.path);
          else this.applyUpdate(op.path, op.data ?? {});
        }
      },
    };
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

  count() {
    return {
      get: async () => ({ data: () => ({ count: this.db.childPaths(this.path).length }) }),
    };
  }

  orderBy(field: string) {
    return new FakeQuery(this.db, this.path, [], field);
  }

  /** Equality filters only — everything the store issues is `field == value`. */
  where(field: string, op: string, value: unknown) {
    if (op !== '==') throw new Error(`FakeCollection.where: unsupported operator ${op}`);
    return new FakeQuery(this.db, this.path, [[field, value]], null);
  }
}

/** A filtered/ordered view over one collection. */
class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly path: string,
    private readonly filters: Array<[string, unknown]>,
    private readonly order: string | null,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') throw new Error(`FakeQuery.where: unsupported operator ${op}`);
    return new FakeQuery(this.db, this.path, [...this.filters, [field, value]], this.order);
  }

  orderBy(field: string): FakeQuery {
    return new FakeQuery(this.db, this.path, this.filters, field);
  }

  private matchingPaths(): string[] {
    const paths = this.db
      .childPaths(this.path)
      .filter((path) =>
        this.filters.every(([field, value]) => this.db.docs.get(path)?.[field] === value),
      );
    if (!this.order) return paths;
    const order = this.order;
    return [...paths].sort((a, b) =>
      String(this.db.docs.get(a)?.[order] ?? '').localeCompare(
        String(this.db.docs.get(b)?.[order] ?? ''),
      ),
    );
  }

  count() {
    return {
      get: async () => ({ data: () => ({ count: this.matchingPaths().length }) }),
    };
  }

  async get() {
    return {
      docs: this.matchingPaths().map((path) => {
        const ref = new FakeDocRef(this.db, path);
        return { id: ref.id, data: () => ({ ...this.db.docs.get(path) }) };
      }),
    };
  }
}

/**
 * Cross-collection view keyed on the last collection segment, so
 * `sites/*\/talons/*` all match one `collectionGroup('talons')`. Exposes
 * `ref.parent.parent.id` because the store reads the owning site back off it.
 */
class FakeCollectionGroup {
  constructor(
    private readonly db: FakeFirestore,
    private readonly collectionId: string,
    private readonly filters: Array<[string, unknown]> = [],
    private readonly order: string | null = null,
  ) {}

  where(field: string, op: string, value: unknown): FakeCollectionGroup {
    if (op !== '==') throw new Error(`FakeCollectionGroup.where: unsupported operator ${op}`);
    return new FakeCollectionGroup(
      this.db,
      this.collectionId,
      [...this.filters, [field, value]],
      this.order,
    );
  }

  orderBy(field: string): FakeCollectionGroup {
    return new FakeCollectionGroup(this.db, this.collectionId, this.filters, field);
  }

  async get() {
    let paths = [...this.db.docs.keys()].filter((path) => {
      const segments = path.split('/');
      return segments.length >= 2 && segments[segments.length - 2] === this.collectionId;
    });
    paths = paths.filter((path) =>
      this.filters.every(([field, value]) => this.db.docs.get(path)?.[field] === value),
    );
    if (this.order) {
      const order = this.order;
      paths = [...paths].sort((a, b) =>
        String(this.db.docs.get(a)?.[order] ?? '').localeCompare(
          String(this.db.docs.get(b)?.[order] ?? ''),
        ),
      );
    }

    return {
      docs: paths.map((path) => {
        const segments = path.split('/');
        const grandparentId = segments.length >= 3 ? segments[segments.length - 3] : undefined;
        return {
          id: segments[segments.length - 1],
          data: () => ({ ...this.db.docs.get(path) }),
          ref: { parent: { parent: grandparentId ? { id: grandparentId } : null } },
        };
      }),
    };
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

  async delete(): Promise<void> {
    this.db.docs.delete(this.path);
  }
}

// Fixtures

const SITE = 'site-a';
const TALONS_PATH = `sites/${SITE}/talons`;
const SECRETS_PATH = `sites/${SITE}/talon_secrets`;

const ADMIN: Actor = { type: 'user', userId: 'admin-uid', role: 'admin', siteRoles: { [SITE]: 'admin' }, machineScopes: { [SITE]: null } };
const MEMBER: Actor = { type: 'user', userId: 'member-uid', role: 'member', siteRoles: { [SITE]: 'member' }, machineScopes: { [SITE]: null } };

let fake: FakeFirestore;
let db: Firestore;

function ctxFor(actor: Actor = ADMIN, overrides: Partial<TalonStoreContext> = {}): TalonStoreContext {
  return {
    siteId: SITE,
    actor,
    auditActor: `user:${actor.type === 'user' ? actor.userId : actor.name}`,
    via: 'ui',
    ...overrides,
  };
}

function talonInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'nightly check',
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    ...overrides,
  };
}

function storedTalon(id: string): TalonDoc {
  return fake.docs.get(`${TALONS_PATH}/${id}`) as unknown as TalonDoc;
}

function seedTalon(id: string, overrides: Partial<TalonDoc> = {}): void {
  const now = new Date('2026-08-01T00:00:00Z');
  fake.docs.set(`${TALONS_PATH}/${id}`, {
    schemaVersion: 1,
    name: id,
    enabled: true,
    trigger: { type: 'schedule', intervalMinutes: 60 },
    condition: { type: 'none' },
    outputs: [{ type: 'email' }],
    scope: { machineIds: null },
    cooldownMinutes: 60,
    createdBy: 'admin-uid',
    createdVia: 'ui',
    createdAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
    ...overrides,
  } as unknown as DocData);
}

async function expectStoreError(
  promise: Promise<unknown>,
  code: TalonStoreErrorCode,
  status: number,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(TalonStoreError);
  await promise.catch((error: TalonStoreError) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
}

function auditAttributes(callIndex = 0): Record<string, unknown> {
  return mockEmitMutation.mock.calls[callIndex][0].attributes as Record<string, unknown>;
}

beforeEach(() => {
  fake = new FakeFirestore();
  db = fake as unknown as Firestore;
  mockAssertLlmKeyAvailable.mockReset();
  mockAssertLlmKeyAvailable.mockResolvedValue(undefined);
  mockValidateWebhookUrl.mockResolvedValue({
    ok: true,
    url: 'https://hooks.example.com/t',
    hostname: 'hooks.example.com',
  });
});

afterEach(() => {
  jest.useRealTimers();
});

// createTalon

describe('createTalon', () => {
  it('persists the normalized input plus the server-owned fields', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        name: '  morning check  ',
        description: '  keeps the lobby wall alive  ',
        trigger: {
          type: 'schedule',
          entries: [{ id: 'e1', days: ['wed', 'mon', 'mon'], time: '09:00' }],
        },
      }),
    );

    const doc = storedTalon(created.id);
    // The store must persist the validator's normalized output.
    expect(doc.name).toBe('morning check');
    expect(doc.description).toBe('keeps the lobby wall alive');
    expect(doc.trigger).toEqual({
      type: 'schedule',
      entries: [{ id: 'e1', days: ['mon', 'wed'], time: '09:00' }],
    });
    // Defaults the caller never sent.
    expect(doc.enabled).toBe(true);
    expect(doc.cooldownMinutes).toBe(60);
    expect(doc.scope).toEqual({ machineIds: null });
    // Server-stamped fields.
    expect(doc.schemaVersion).toBe(1);
    expect(doc.createdBy).toBe('admin-uid');
    expect(doc.createdVia).toBe('ui');
    expect(doc.consecutiveFailures).toBe(0);
    expect(doc.createdAt).toBeInstanceOf(Date);
    expect(doc.updatedAt).toBeInstanceOf(Date);
    expect(created).toEqual({ id: created.id, ...doc });
  });

  it('rejects server-owned fields sent by the caller', async () => {
    await expectStoreError(
      createTalon(db, ctxFor(), talonInput({ createdBy: 'someone-else', schemaVersion: 9 })),
      'invalid_talon',
      400,
    );
    expect(fake.docs.size).toBe(0);
  });

  it('reports every field error on invalid input', async () => {
    const error = await createTalon(db, ctxFor(), { name: '' }).catch(
      (caught: TalonStoreError) => caught,
    );
    expect(error).toBeInstanceOf(TalonStoreError);
    expect((error as TalonStoreError).fieldErrors?.length).toBeGreaterThan(1);
  });

  it('stamps nextRunAt for a schedule trigger', async () => {
    const before = Date.now();
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({ trigger: { type: 'schedule', intervalMinutes: 30 } }),
    );
    const nextRunAt = created.nextRunAt as Date;
    expect(nextRunAt).toBeInstanceOf(Date);
    expect(nextRunAt.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it('resolves clock-time entries against the site timezone', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-10T12:00:00Z') });
    fake.docs.set(`sites/${SITE}`, { timezone: 'America/New_York' });

    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'schedule', entries: [{ id: 'e1', days: ['mon'], time: '09:00' }] },
      }),
    );

    // 09:00 EDT on the same Monday — 13:00Z, not 09:00Z.
    expect((created.nextRunAt as Date).toISOString()).toBe('2026-08-10T13:00:00.000Z');
  });

  it('falls back to UTC when the site has no timezone', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-10T12:00:00Z') });

    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'schedule', entries: [{ id: 'e1', days: ['mon'], time: '09:00' }] },
      }),
    );

    // 09:00 UTC has already passed, so the next fire is the following Monday.
    expect((created.nextRunAt as Date).toISOString()).toBe('2026-08-17T09:00:00.000Z');
  });

  it('omits nextRunAt entirely for non-schedule triggers', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        trigger: { type: 'threshold', metric: 'cpu_percent', operator: '>', value: 90 },
      }),
    );
    // Absent, not null — null satisfies the sweep's `nextRunAt <= now` filter.
    expect('nextRunAt' in storedTalon(created.id)).toBe(false);
    expect('nextRunAt' in created).toBe(false);
  });

  it('mints a webhook signing secret in talon_secrets and keeps it off the talon', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] }),
    );

    const secretDoc = fake.docs.get(`${SECRETS_PATH}/${created.id}`);
    expect(secretDoc).toBeDefined();
    expect(secretDoc?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(secretDoc?.talonId).toBe(created.id);

    // The secret must not leak onto the talon document or the return value.
    expect(JSON.stringify(storedTalon(created.id))).not.toContain('whsec_');
    expect(JSON.stringify(created)).not.toContain('whsec_');
    expect(Object.keys(storedTalon(created.id))).not.toContain('secret');
  });

  it('does not mint a secret when there is no webhook output', async () => {
    const created = await createTalon(db, ctxFor(), talonInput());
    expect(fake.docs.has(`${SECRETS_PATH}/${created.id}`)).toBe(false);
  });

  it('runs the full SSRF check on webhook urls', async () => {
    mockValidateWebhookUrl.mockResolvedValue({
      ok: false,
      reason: 'private_ip',
      detail: 'hooks.internal resolves to private ipv4 10.0.0.5',
    });

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.internal/t' }] }),
      ),
      'invalid_webhook_url',
      400,
    );
    expect(mockValidateWebhookUrl).toHaveBeenCalledWith('https://hooks.internal/t');
    expect(fake.docs.size).toBe(0);
  });

  it('enforces the per-site talon cap', async () => {
    for (let index = 0; index < MAX_TALONS_PER_SITE; index++) seedTalon(`talon-${index}`);

    await expectStoreError(createTalon(db, ctxFor(), talonInput()), 'talon_limit_reached', 409);
    expect(fake.childPaths(TALONS_PATH)).toHaveLength(MAX_TALONS_PER_SITE);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('allows a create that fills the last slot', async () => {
    for (let index = 0; index < MAX_TALONS_PER_SITE - 1; index++) seedTalon(`talon-${index}`);
    await expect(createTalon(db, ctxFor(), talonInput())).resolves.toBeDefined();
  });

  it('refuses command outputs authored by a non-admin', async () => {
    await expectStoreError(
      createTalon(
        db,
        ctxFor(MEMBER),
        talonInput({
          outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
        }),
      ),
      'command_output_forbidden',
      403,
    );
    expect(fake.docs.size).toBe(0);
  });

  it('allows command outputs authored by a site admin', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({
        outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
      }),
    );
    expect(storedTalon(created.id).outputs).toEqual([
      { type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' },
    ]);
  });

  it('refuses command outputs from an admin of a different site', async () => {
    const otherSiteAdmin: Actor = {
      type: 'user',
      userId: 'admin-elsewhere',
      role: 'admin',
      siteRoles: { ['site-b']: 'admin' },
      machineScopes: { ['site-b']: null },
    };
    await expectStoreError(
      createTalon(
        db,
        ctxFor(otherSiteAdmin),
        talonInput({
          outputs: [{ type: 'command', commandType: 'stop_process', processName: 'TouchDesigner' }],
        }),
      ),
      'command_output_forbidden',
      403,
    );
  });

  it('refuses a hoot output that lets hoot act, authored by a non-admin', async () => {
    // Same power as a `command` output (tier-2 tools can restart the same
    // process), so it takes the same privilege.
    await expectStoreError(
      createTalon(
        db,
        ctxFor(MEMBER),
        talonInput({
          outputs: [{ type: 'cortex', directive: 'restart it', allowActions: true }],
        }),
      ),
      'hoot_actions_forbidden',
      403,
    );
    expect(fake.docs.size).toBe(0);
  });

  it('allows a read-only hoot output authored by a non-admin', async () => {
    const created = await createTalon(
      db,
      ctxFor(MEMBER),
      talonInput({ outputs: [{ type: 'cortex', directive: 'have a look' }] }),
    );
    expect(storedTalon(created.id).outputs).toEqual([
      { type: 'cortex', directive: 'have a look' },
    ]);
  });

  it('allows a hoot output that lets hoot act, authored by a site admin', async () => {
    const created = await createTalon(
      db,
      ctxFor(),
      talonInput({ outputs: [{ type: 'cortex', directive: 'restart it', allowActions: true }] }),
    );
    expect(storedTalon(created.id).outputs).toEqual([
      { type: 'cortex', directive: 'restart it', allowActions: true },
    ]);
  });

  it("requires the author's own llm key for a visual_check condition", async () => {
    mockAssertLlmKeyAvailable.mockRejectedValue(
      new Error('No LLM API key configured. Add one in Account Settings → hoot.'),
    );

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({
          condition: { type: 'visual_check', expectation: 'the wall shows the show loop' },
          trigger: { type: 'schedule', intervalMinutes: 30 },
        }),
      ),
      'llm_key_required',
      400,
    );
    // The AUTHORING uid — there is no site-level key scope.
    expect(mockAssertLlmKeyAvailable).toHaveBeenCalledWith(db, 'admin-uid');
    expect(fake.docs.size).toBe(0);
  });

  it("requires the author's own llm key for a hoot output", async () => {
    mockAssertLlmKeyAvailable.mockRejectedValue(
      new Error('Failed to decrypt the stored LLM API key.'),
    );

    await expectStoreError(
      createTalon(
        db,
        ctxFor(),
        talonInput({ outputs: [{ type: 'cortex', directive: 'investigate the black screen' }] }),
      ),
      'llm_key_required',
      400,
    );
  });

  it('names the one screen that fixes a missing key, and leaks nothing else', async () => {
    mockAssertLlmKeyAvailable.mockRejectedValue(
      new Error('Failed to decrypt the stored LLM API key using OWLETTE_LLM_KEY.'),
    );

    const error = await createTalon(
      db,
      ctxFor(),
      talonInput({ outputs: [{ type: 'cortex', directive: 'look' }] }),
    ).catch((err: TalonStoreError) => err);

    expect((error as TalonStoreError).message).toBe(
      'this talon uses ai, so it needs an ai key. add one in settings → hoot, then save again.',
    );
    // The underlying failure names server infra; it must not travel.
    expect((error as TalonStoreError).message).not.toContain('OWLETTE_LLM_KEY');
  });

  it('refuses an ai talon authored by a system actor, which has no key to spend', async () => {
    await expectStoreError(
      createTalon(
        db,
        { ...ctxFor(), actor: { type: 'system', name: 'talon_runner', siteId: SITE } as Actor },
        talonInput({ outputs: [{ type: 'cortex', directive: 'look' }] }),
      ),
      'llm_key_required',
      400,
    );
    expect(mockAssertLlmKeyAvailable).not.toHaveBeenCalled();
  });

  it('does not consult the llm key for talons that never call the model', async () => {
    await createTalon(db, ctxFor(), talonInput());
    expect(mockAssertLlmKeyAvailable).not.toHaveBeenCalled();
  });

  it('emits a talon.create audit', async () => {
    const created = await createTalon(db, ctxFor(), talonInput());

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    expect(mockEmitMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'talon_mutated',
        siteId: SITE,
        actor: 'user:admin-uid',
        targetId: created.id,
      }),
    );
    expect(auditAttributes()).toEqual({
      verb: 'talon.create',
      endpoint: `/api/sites/${SITE}/talons`,
      method: 'POST',
      via: 'ui',
    });
  });

  it('records the hoot provenance when hoot authors the talon', async () => {
    const created = await createTalon(
      db,
      ctxFor(ADMIN, { via: 'cortex', chatId: 'chat-7', auditActor: 'cortex:user_admin-uid' }),
      talonInput(),
    );

    expect(storedTalon(created.id).createdVia).toBe('cortex');
    expect(storedTalon(created.id).chatId).toBe('chat-7');
    expect(auditAttributes()).toMatchObject({ via: 'cortex', chatId: 'chat-7' });
  });
});

// updateTalon

describe('updateTalon', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(
      updateTalon(db, ctxFor(), 'missing', talonInput()),
      'talon_not_found',
      404,
    );
  });

  it('replaces the caller-owned fields and bumps updatedAt', async () => {
    seedTalon('t1');
    const updated = await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ name: 'renamed', cooldownMinutes: 15 }),
    );

    expect(updated.name).toBe('renamed');
    expect(updated.cooldownMinutes).toBe(15);
    expect(updated.id).toBe('t1');
    // Run bookkeeping and creation provenance survive an edit.
    expect(updated.createdBy).toBe('admin-uid');
    expect(updated.consecutiveFailures).toBe(0);
    expect((updated.updatedAt as Date).getTime()).toBeGreaterThan(
      new Date('2026-08-01T00:00:00Z').getTime(),
    );
  });

  it('recomputes nextRunAt when the trigger changes', async () => {
    seedTalon('t1', { nextRunAt: new Date('2020-01-01T00:00:00Z') });

    const before = Date.now();
    const updated = await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ trigger: { type: 'schedule', intervalMinutes: 120 } }),
    );

    expect((updated.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 120 * 60_000);
  });

  it('leaves nextRunAt alone when the trigger is unchanged', async () => {
    const stale = new Date('2026-08-09T00:00:00Z');
    seedTalon('t1', { nextRunAt: stale });

    const updated = await updateTalon(db, ctxFor(), 't1', talonInput({ name: 'renamed' }));

    expect(updated.nextRunAt).toEqual(stale);
  });

  it('removes nextRunAt when the trigger stops being a schedule', async () => {
    seedTalon('t1', { nextRunAt: new Date('2026-08-09T00:00:00Z') });

    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({
        trigger: { type: 'event', eventTypes: ['process_crash'] },
      }),
    );

    expect('nextRunAt' in storedTalon('t1')).toBe(false);
  });

  it('clears a description that was removed', async () => {
    seedTalon('t1', { description: 'old copy' });
    await updateTalon(db, ctxFor(), 't1', talonInput());
    expect('description' in storedTalon('t1')).toBe(false);
  });

  it('emits a talon.update audit listing only the changed fields', async () => {
    seedTalon('t1');
    await updateTalon(db, ctxFor(), 't1', talonInput({ name: 'renamed', cooldownMinutes: 15 }));

    expect(auditAttributes()).toEqual({
      verb: 'talon.update',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'PATCH',
      changedFields: ['name', 'cooldownMinutes'],
      via: 'ui',
    });
  });

  it('reports an empty changed-field list for a no-op edit', async () => {
    seedTalon('t1', { name: 'nightly check' });
    await updateTalon(db, ctxFor(), 't1', talonInput());
    expect(auditAttributes().changedFields).toEqual([]);
  });

  it('mints a secret when a webhook output is added later', async () => {
    seedTalon('t1');
    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({ outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] }),
    );

    expect(fake.docs.get(`${SECRETS_PATH}/t1`)?.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(JSON.stringify(storedTalon('t1'))).not.toContain('whsec_');
  });

  it('keeps an existing secret stable across edits', async () => {
    seedTalon('t1', { outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] });
    fake.docs.set(`${SECRETS_PATH}/t1`, { talonId: 't1', secret: `whsec_${'a'.repeat(64)}` });

    await updateTalon(
      db,
      ctxFor(),
      't1',
      talonInput({
        name: 'renamed',
        outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }],
      }),
    );

    expect(fake.docs.get(`${SECRETS_PATH}/t1`)?.secret).toBe(`whsec_${'a'.repeat(64)}`);
  });

  it('refuses to add a command output as a non-admin', async () => {
    seedTalon('t1');
    await expectStoreError(
      updateTalon(
        db,
        ctxFor(MEMBER),
        't1',
        talonInput({
          outputs: [{ type: 'command', commandType: 'restart_process', processName: 'TouchDesigner' }],
        }),
      ),
      'command_output_forbidden',
      403,
    );
    expect(storedTalon('t1').outputs).toEqual([{ type: 'email' }]);
  });

  it('refuses an edit that lets hoot act, as a non-admin', async () => {
    seedTalon('t1');
    await expectStoreError(
      updateTalon(
        db,
        ctxFor(MEMBER),
        't1',
        talonInput({
          outputs: [{ type: 'cortex', directive: 'restart it', allowActions: true }],
        }),
      ),
      'hoot_actions_forbidden',
      403,
    );
    expect(storedTalon('t1').outputs).toEqual([{ type: 'email' }]);
  });

  it("refuses an edit that adds a hoot output without the author's llm key", async () => {
    seedTalon('t1');
    mockAssertLlmKeyAvailable.mockRejectedValue(new Error('No LLM API key configured.'));

    await expectStoreError(
      updateTalon(
        db,
        ctxFor(),
        't1',
        talonInput({ outputs: [{ type: 'cortex', directive: 'restart the show' }] }),
      ),
      'llm_key_required',
      400,
    );
    expect(storedTalon('t1').outputs).toEqual([{ type: 'email' }]);
  });

  it("checks the original AUTHOR's key, not the editor's", async () => {
    // `createdBy` is immutable, so the talon keeps running on the original
    // author's key however many admins edit it.
    seedTalon('t1', { createdBy: 'original-author' });

    await updateTalon(
      db,
      ctxFor({ type: 'user', userId: 'second-admin', role: 'admin', siteRoles: { [SITE]: 'admin' }, machineScopes: { [SITE]: null } }),
      't1',
      talonInput({ outputs: [{ type: 'cortex', directive: 'restart the show' }] }),
    );

    expect(mockAssertLlmKeyAvailable).toHaveBeenCalledWith(db, 'original-author');
  });
});

// setTalonEnabled

describe('setTalonEnabled', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(
      setTalonEnabled(db, ctxFor(), 'missing', true),
      'talon_not_found',
      404,
    );
  });

  it('re-arms a stale nextRunAt when enabling', async () => {
    seedTalon('t1', { enabled: false, nextRunAt: new Date('2020-01-01T00:00:00Z') });

    const before = Date.now();
    const updated = await setTalonEnabled(db, ctxFor(), 't1', true);

    expect(updated.enabled).toBe(true);
    expect((updated.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000);
  });

  it('removes nextRunAt when enabling a non-schedule talon', async () => {
    seedTalon('t1', {
      enabled: false,
      trigger: { type: 'event', eventTypes: ['machine_offline'] },
      nextRunAt: new Date('2020-01-01T00:00:00Z'),
    });

    await setTalonEnabled(db, ctxFor(), 't1', true);

    expect('nextRunAt' in storedTalon('t1')).toBe(false);
  });

  it('leaves nextRunAt untouched when disabling', async () => {
    const stale = new Date('2020-01-01T00:00:00Z');
    seedTalon('t1', { nextRunAt: stale });

    const updated = await setTalonEnabled(db, ctxFor(), 't1', false);

    expect(updated.enabled).toBe(false);
    expect(updated.nextRunAt).toEqual(stale);
    expect(mockAssertLlmKeyAvailable).not.toHaveBeenCalled();
  });

  it("refuses to enable a talon whose author's llm key is gone", async () => {
    seedTalon('t1', {
      enabled: false,
      condition: { type: 'visual_check', expectation: 'the loop is playing' },
    });
    mockAssertLlmKeyAvailable.mockRejectedValue(new Error('No LLM API key configured.'));

    await expectStoreError(
      setTalonEnabled(db, ctxFor(), 't1', true),
      'llm_key_required',
      400,
    );
    expect(storedTalon('t1').enabled).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'clears a system disabledReason when a person moves the switch to %p',
    async (enabled) => {
      seedTalon('t1', { enabled: !enabled, disabledReason: 'creator_access_revoked' });

      await setTalonEnabled(db, ctxFor(), 't1', enabled);

      // Deleted, not blanked — a re-armed talon must not still claim a cause.
      expect('disabledReason' in storedTalon('t1')).toBe(false);
    },
  );

  it('does not write a disabledReason delete when there was none', async () => {
    seedTalon('t1', { enabled: false });

    await setTalonEnabled(db, ctxFor(), 't1', true);

    expect('disabledReason' in storedTalon('t1')).toBe(false);
  });

  it('emits talon.enable and talon.disable audits', async () => {
    seedTalon('t1');

    await setTalonEnabled(db, ctxFor(), 't1', true);
    expect(auditAttributes()).toEqual({
      verb: 'talon.enable',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'PATCH',
      changedFields: ['enabled'],
      via: 'ui',
    });

    await setTalonEnabled(db, ctxFor(), 't1', false);
    expect(auditAttributes(1)).toMatchObject({ verb: 'talon.disable' });
  });
});

// deleteTalon

describe('deleteTalon', () => {
  it('rejects an unknown talon', async () => {
    await expectStoreError(deleteTalon(db, ctxFor(), 'missing'), 'talon_not_found', 404);
  });

  it('deletes the talon and its signing secret', async () => {
    seedTalon('t1', { outputs: [{ type: 'webhook', url: 'https://hooks.example.com/t' }] });
    fake.docs.set(`${SECRETS_PATH}/t1`, { talonId: 't1', secret: `whsec_${'b'.repeat(64)}` });
    seedTalon('t2');

    await deleteTalon(db, ctxFor(), 't1');

    expect(fake.docs.has(`${TALONS_PATH}/t1`)).toBe(false);
    expect(fake.docs.has(`${SECRETS_PATH}/t1`)).toBe(false);
    expect(fake.docs.has(`${TALONS_PATH}/t2`)).toBe(true);
    expect(auditAttributes()).toEqual({
      verb: 'talon.delete',
      endpoint: `/api/sites/${SITE}/talons/t1`,
      method: 'DELETE',
      via: 'ui',
    });
  });

  it('deletes a secretless talon without complaining', async () => {
    seedTalon('t1');
    await expect(deleteTalon(db, ctxFor(), 't1')).resolves.toBeUndefined();
    expect(fake.docs.has(`${TALONS_PATH}/t1`)).toBe(false);
  });
});

// reads

describe('getTalon / listTalons', () => {
  it('returns null for a talon that does not exist', async () => {
    await expect(getTalon(db, SITE, 'missing')).resolves.toBeNull();
  });

  it('returns the talon with its id', async () => {
    seedTalon('t1', { name: 'lobby watch' });
    await expect(getTalon(db, SITE, 't1')).resolves.toMatchObject({
      id: 't1',
      name: 'lobby watch',
    });
  });

  it('lists the site talons ordered by name', async () => {
    seedTalon('t1', { name: 'zebra' });
    seedTalon('t2', { name: 'alpha' });
    seedTalon('t3', { name: 'mango' });

    const talons = await listTalons(db, SITE);

    expect(talons.map((talon) => talon.name)).toEqual(['alpha', 'mango', 'zebra']);
    expect(talons.map((talon) => talon.id)).toEqual(['t2', 't3', 't1']);
  });

  it('returns an empty list for a site with no talons', async () => {
    await expect(listTalons(db, SITE)).resolves.toEqual([]);
  });
});

// reassign — authorship survives a departure

describe('countTalonsAuthoredBy / listTalonsAuthoredBy', () => {
  it('counts only the talons the named uid authored', async () => {
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });
    seedTalon('t2', { name: 'beta', createdBy: 'leaver-uid' });
    seedTalon('t3', { name: 'gamma', createdBy: 'someone-else' });

    await expect(countTalonsAuthoredBy(db, SITE, 'leaver-uid')).resolves.toBe(2);
    await expect(countTalonsAuthoredBy(db, SITE, 'someone-else')).resolves.toBe(1);
    await expect(countTalonsAuthoredBy(db, SITE, 'never-authored')).resolves.toBe(0);
  });

  it('lists them by name so the warning can name what breaks', async () => {
    seedTalon('t1', { name: 'zebra', createdBy: 'leaver-uid' });
    seedTalon('t2', { name: 'alpha', createdBy: 'leaver-uid' });
    seedTalon('t3', { name: 'mango', createdBy: 'other-uid' });

    const talons = await listTalonsAuthoredBy(db, SITE, 'leaver-uid');
    expect(talons.map((talon) => talon.name)).toEqual(['alpha', 'zebra']);
  });
});

describe('listTalonsAuthoredByAcrossSites', () => {
  it('reaches sites the user is not a member of', async () => {
    seedTalon('t1', { name: 'lobby', createdBy: 'leaver-uid' });
    // Same author, second site — a walk of `users/{uid}.sites[]` misses this
    // for a superadmin.
    fake.docs.set('sites/site-b/talons/t9', {
      name: 'atrium',
      enabled: false,
      createdBy: 'leaver-uid',
      outputs: [{ type: 'email' }],
    });
    fake.docs.set('sites/site-b/talons/t8', {
      name: 'somebody else',
      enabled: true,
      createdBy: 'other-uid',
      outputs: [{ type: 'email' }],
    });

    const authored = await listTalonsAuthoredByAcrossSites(db, 'leaver-uid');

    expect(authored).toEqual([
      { siteId: 'site-b', talonId: 't9', name: 'atrium', enabled: false },
      { siteId: SITE, talonId: 't1', name: 'lobby', enabled: true },
    ]);
  });
});

describe('reassignTalons', () => {
  /**
   * An eligible successor: a site admin here, not deleted.
   *
   * The membership row is what makes them eligible — the global role grants
   * nothing on a site now, so seeding only `users/{uid}` produces a successor the
   * store correctly refuses. `siteRole: null` seeds no row, for the tests that
   * want that refusal.
   */
  function seedSuccessor(
    uid: string,
    overrides: DocData = {},
    siteRole: 'owner' | 'admin' | 'member' | null = 'admin',
    memberFields: DocData = {},
  ): void {
    fake.docs.set(`users/${uid}`, { role: 'admin', sites: [SITE], ...overrides });
    if (siteRole === null) return;
    fake.docs.set(`sites/${SITE}/members/${uid}`, {
      uid,
      role: siteRole,
      status: 'active',
      addedAt: new Date(0),
      addedBy: 'system:test',
      ...memberFields,
    });
  }

  /** the actor the author gates were asked about for `uid`. */
  function gateActorFor(uid: string): UserActor {
    const call = mockCapabilityCheck.mock.calls.find(
      ([actor]) => (actor as UserActor).userId === uid,
    );
    return call?.[0] as UserActor;
  }

  it('moves every talon the departing author wrote', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });
    seedTalon('t2', { name: 'beta', createdBy: 'leaver-uid' });
    seedTalon('t3', { name: 'gamma', createdBy: 'bystander-uid' });

    const result = await reassignTalons(db, ctxFor(), 'successor-uid', {
      fromUid: 'leaver-uid',
    });

    expect(result.reassignedTalonIds.sort()).toEqual(['t1', 't2']);
    expect(storedTalon('t1').createdBy).toBe('successor-uid');
    expect(storedTalon('t2').createdBy).toBe('successor-uid');
    // Untouched: a bystander's talon is not swept up by a departure.
    expect(storedTalon('t3').createdBy).toBe('bystander-uid');
  });

  // Live defect once: `reassignTalons` wrote `createdBy` and nothing else, so
  // a handover left the talons still disabled and still blaming the departed
  // author.

  it('re-arms a talon the system disabled because its creator left', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', {
      createdBy: 'leaver-uid',
      enabled: false,
      disabledReason: 'creator_access_revoked',
      consecutiveFailures: 3,
    });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    const stored = storedTalon('t1');
    expect(stored.createdBy).toBe('successor-uid');
    expect(stored.enabled).toBe(true);
    expect(stored.disabledReason).toBeUndefined();
    // A fresh author starts on a clean sheet, not one strike from auto-disable.
    expect(stored.consecutiveFailures).toBe(0);
  });

  it('leaves repeated_failures disabled — reassignment fixes nothing about it', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', {
      createdBy: 'leaver-uid',
      enabled: false,
      disabledReason: 'repeated_failures',
    });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    const stored = storedTalon('t1');
    expect(stored.createdBy).toBe('successor-uid');
    expect(stored.enabled).toBe(false);
    expect(stored.disabledReason).toBe('repeated_failures');
  });

  it('leaves a human-paused talon paused', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { createdBy: 'leaver-uid', enabled: false });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    expect(storedTalon('t1').enabled).toBe(false);
  });

  it('refuses a successor with no ai key when the talons use ai', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', {
      createdBy: 'leaver-uid',
      condition: { type: 'visual_check', expectation: 'the screen shows the loop' },
    });
    mockAssertLlmKeyAvailable.mockRejectedValue(new Error('no key'));

    await expect(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
    ).rejects.toMatchObject({ status: 400, code: 'successor_invalid' });

    // Refused means refused: nothing moved.
    expect(storedTalon('t1').createdBy).toBe('leaver-uid');
    expect(mockAssertLlmKeyAvailable).toHaveBeenCalledWith(db, 'successor-uid');
  });

  it('does not demand a key from a successor taking on talons that never use ai', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { createdBy: 'leaver-uid' });
    mockAssertLlmKeyAvailable.mockRejectedValue(new Error('no key'));

    await expect(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
    ).resolves.toMatchObject({ reassignedTalonIds: ['t1'] });
  });

  it('emits one talon.reassign audit row per talon, naming both authors', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
    const event = mockEmitMutation.mock.calls[0][0];
    expect(event).toMatchObject({
      kind: 'talon_mutated',
      siteId: SITE,
      actor: 'user:admin-uid',
      // The talon, not the user — "did this talon change?" must stay
      // answerable from the audit log.
      targetId: 't1',
    });
    expect(auditAttributes()).toMatchObject({
      verb: 'talon.reassign',
      method: 'POST',
      endpoint: `/api/sites/${SITE}/talons`,
      changedFields: ['createdBy'],
      previousCreatedBy: 'leaver-uid',
      newCreatedBy: 'successor-uid',
      via: 'ui',
    });
  });

  it('moves an explicit list of talons', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });
    seedTalon('t2', { name: 'beta', createdBy: 'leaver-uid' });

    const result = await reassignTalons(db, ctxFor(), 'successor-uid', { talonIds: ['t2'] });

    expect(result.reassignedTalonIds).toEqual(['t2']);
    expect(storedTalon('t1').createdBy).toBe('leaver-uid');
    expect(storedTalon('t2').createdBy).toBe('successor-uid');
  });

  it('skips talons the successor already authored without writing or auditing', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });
    seedTalon('t2', { name: 'beta', createdBy: 'successor-uid' });

    const result = await reassignTalons(db, ctxFor(), 'successor-uid', {
      talonIds: ['t1', 't2'],
    });

    expect(result).toMatchObject({
      reassignedTalonIds: ['t1'],
      skippedTalonIds: ['t2'],
    });
    expect(mockEmitMutation).toHaveBeenCalledTimes(1);
  });

  it('refuses a soft-deleted successor', async () => {
    seedSuccessor('successor-uid', { deletedAt: 1_700_000_000_000 });
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
      'successor_invalid',
      400,
    );
    expect(storedTalon('t1').createdBy).toBe('leaver-uid');
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses a successor with no access to the site', async () => {
    // No membership on THIS site: TALON_MANAGE is site-scoped, so this is the
    // "handed it to someone who cannot run it" failure. The global `admin` role
    // on the seeded user document is deliberately left in place — it must not
    // rescue them.
    seedSuccessor('successor-uid', { sites: ['site-elsewhere'] }, null);
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
      'successor_invalid',
      400,
    );
    expect(storedTalon('t1').createdBy).toBe('leaver-uid');
  });

  it('refuses a member — TALON_MANAGE is what authoring takes', async () => {
    seedSuccessor('successor-uid', { role: 'member' }, 'member');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
      'successor_invalid',
      400,
    );
  });

  it('refuses a successor that does not exist', async () => {
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'ghost-uid', { fromUid: 'leaver-uid' }),
      'successor_invalid',
      400,
    );
  });

  it('accepts a superadmin who is assigned to no sites', async () => {
    seedSuccessor('successor-uid', { role: 'superadmin', sites: [] });
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    expect(storedTalon('t1').createdBy).toBe('successor-uid');
  });

  it('carries a successor admin held to view to the gates, so it never controls', async () => {
    seedSuccessor('successor-uid', {}, 'admin', { swoop: 'view' });
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    const successor = gateActorFor('successor-uid');
    expect(successor.swoopModes[SITE]).toBe('view');
    expect(hasCapability(successor, Capability.MACHINE_REMOTE_CONTROL, SITE)).toBe(false);
    // the mode changes swoop and nothing else: they still inherit
    expect(storedTalon('t1').createdBy).toBe('successor-uid');
  });

  it('builds a successor actor with no mode and the whole site from a row that carries neither', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

    const successor = gateActorFor('successor-uid');
    expect(successor).toEqual({
      type: 'user',
      userId: 'successor-uid',
      role: 'admin',
      siteRoles: { [SITE]: 'admin' },
      swoopModes: {},
      machineScopes: { [SITE]: null },
    });
  });

  describe('machine scope', () => {
    // TALON_MANAGE is site-wide, because a talon spans the site's machines. the
    // store's rejection reason surfaces only as its detail.
    async function expectInsufficientRole(): Promise<void> {
      await expect(
        reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'successor_invalid',
        message: expect.stringContaining('must be a site admin'),
      });
      expect(storedTalon('t1').createdBy).toBe('leaver-uid');
      expect(mockEmitMutation).not.toHaveBeenCalled();
    }

    it('refuses a scoped admin with insufficient_role', async () => {
      seedSuccessor('successor-uid', {}, 'admin', { machineIds: ['m1'] });
      seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

      await expectInsufficientRole();
      expect(machineScopeOf(gateActorFor('successor-uid'), SITE)).toEqual(['m1']);
    });

    it('refuses a member set to swoop control: a mode never grants TALON_MANAGE', async () => {
      seedSuccessor('successor-uid', { role: 'member' }, 'member', { swoop: 'control' });
      seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

      await expectInsufficientRole();
      expect(gateActorFor('successor-uid').swoopModes[SITE]).toBe('control');
    });

    it('accepts a whole-site admin', async () => {
      seedSuccessor('successor-uid');
      seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

      await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

      expect(storedTalon('t1').createdBy).toBe('successor-uid');
      expect(machineScopeOf(gateActorFor('successor-uid'), SITE)).toBeNull();
    });
  });

  it('writes nothing when one talon in the selection is missing', async () => {
    seedSuccessor('successor-uid');
    seedTalon('t1', { name: 'alpha', createdBy: 'leaver-uid' });

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { talonIds: ['t1', 'ghost'] }),
      'talon_not_found',
      404,
    );
    // All-or-nothing — a partial move orphans automations with no signal which.
    expect(storedTalon('t1').createdBy).toBe('leaver-uid');
  });

  it('rejects a selection that names neither or both selectors', async () => {
    seedSuccessor('successor-uid');

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', {}),
      'invalid_reassign',
      400,
    );
    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid', talonIds: ['t1'] }),
      'invalid_reassign',
      400,
    );
  });

  it('rejects reassigning a user to themselves', async () => {
    seedSuccessor('successor-uid');

    await expectStoreError(
      reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'successor-uid' }),
      'invalid_reassign',
      400,
    );
  });

  it('rejects a malformed successor id before reading anything', async () => {
    await expectStoreError(
      reassignTalons(db, ctxFor(), '../escape', { fromUid: 'leaver-uid' }),
      'invalid_reassign',
      400,
    );
  });

  describe('privileged outputs', () => {
    // Coverage caveat: the store checks MACHINE_EXEC_COMMAND separately from
    // TALON_MANAGE, but the matrix grants both to the same roles, so no
    // seedable user fails only the second. These pin observable behaviour, not
    // the isolated inner gate.
    it('refuses an ineligible successor for a talon that runs commands', async () => {
      seedSuccessor('successor-uid', { sites: ['site-elsewhere'] }, null);
      seedTalon('t1', {
        name: 'alpha',
        createdBy: 'leaver-uid',
        outputs: [{ type: 'command', command: 'restart', processId: 'p1' }],
      });

      await expectStoreError(
        reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' }),
        'successor_invalid',
        400,
      );
    });

    it('allows a site admin to inherit a talon that lets hoot act', async () => {
      seedSuccessor('successor-uid');
      seedTalon('t1', {
        name: 'alpha',
        createdBy: 'leaver-uid',
        outputs: [{ type: 'cortex', prompt: 'look at it', allowActions: true }],
      });

      await reassignTalons(db, ctxFor(), 'successor-uid', { fromUid: 'leaver-uid' });

      expect(storedTalon('t1').createdBy).toBe('successor-uid');
    });
  });
});
