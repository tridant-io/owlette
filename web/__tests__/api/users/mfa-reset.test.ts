/** @jest-environment node */

/**
 * `POST /api/users/{uid}/mfa-reset` — superadmin recovery for an account that
 * has lost every second factor AND its backup codes.
 *
 * Harness follows `__tests__/api/users/deletions/route.test.ts`: path-keyed
 * in-memory Firestore, mocked `resolveAuth`, but the REAL
 * `authorizedPlatformHandler` / `capabilities` / `mfaFactors.server` /
 * `deviceTrust.server`, so the gate, factor recompute and trusted-device sweep
 * run for real rather than against always-agreeing stubs.
 *
 * The four properties that would hurt if broken:
 *   1. Reset really empties the account (no TOTP, backup codes, passkeys, or
 *      trusted devices) and re-arms mandatory setup rather than leaving it open.
 *   2. A non-superadmin is refused with NOTHING written — a route that 403s
 *      after mutating is worse than no route.
 *   3. The audit trail names both parties; a silent reset is indistinguishable
 *      from an attacker holding a superadmin session.
 *   4. Resetting a factor-less user is a safe no-op — that's the state an
 *      operator retries into after a partial failure.
 */

import { createMockRequest } from '../helpers/utils';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockSendEmail = jest.fn();
jest.mock('@/lib/resendClient.server', () => ({
  ...jest.requireActual('@/lib/resendClient.server'),
  getResend: () => ({ emails: { send: (...a: unknown[]) => mockSendEmail(...a) } }),
}));

const mockEmitMutation = jest.fn();
jest.mock('@/lib/auditLogClient', () => ({
  emitApiKeyUsed: jest.fn(),
  emitMutation: (...a: unknown[]) => mockEmitMutation(...a),
  scopeFingerprint: jest.fn(() => 'fp'),
}));

const mockResolveAuth = jest.fn();
jest.mock('@/lib/apiAuth.server', () => {
  const actual = jest.requireActual('@/lib/apiAuth.server');
  return {
    ...actual,
    resolveAuth: (...a: unknown[]) => mockResolveAuth(...a),
  };
});

jest.mock('@/lib/rateLimit.server', () => ({
  checkRateLimit: jest.fn(async () => ({ ok: true })),
  rateLimitHeaders: () => ({}),
}));

jest.mock('@/lib/securityConfig.server', () => ({
  securityConfig: {
    read: jest.fn(async () => ({
      capability_enforcement: true,
      rate_limit_enforcement: true,
    })),
  },
}));

const DELETE_SENTINEL = { __sentinel: 'delete' };
const SERVER_TIMESTAMP = { __sentinel: 'serverTimestamp' };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    delete: () => DELETE_SENTINEL,
    serverTimestamp: () => SERVER_TIMESTAMP,
  },
}));

// Firestore mock — a flat path -> data map.
type Data = Record<string, unknown>;

/** Every doc, keyed by full slash-joined path. */
const store = new Map<string, Data>();

/** Auto-ids for `collection(...).doc()` with no id (the audit-row writer). */
let autoIdCounter = 0;

/** Apply a set/update, honoring both FieldValue sentinels and `{ merge: true }`. */
function applyWrite(path: string, payload: Data, merge: boolean): void {
  const base = merge ? { ...(store.get(path) ?? {}) } : {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === DELETE_SENTINEL) {
      delete base[key];
    } else if (value === SERVER_TIMESTAMP) {
      base[key] = '__SERVER_TIMESTAMP__';
    } else {
      base[key] = value;
    }
  }
  store.set(path, base);
}

interface FakeDocRef {
  __kind: 'doc';
  id: string;
  path: string;
  collection(name: string): FakeCollectionRef;
  get(): Promise<unknown>;
  set(payload: Data, options?: { merge?: boolean }): Promise<void>;
  update(payload: Data): Promise<void>;
  delete(): Promise<void>;
}

interface FakeCollectionRef {
  __kind: 'collection';
  path: string;
  doc(id?: string): FakeDocRef;
  get(): Promise<unknown>;
}

function snapshotOf(path: string) {
  const data = store.get(path);
  return {
    exists: data !== undefined,
    id: path.split('/').pop() as string,
    data: () => data,
  };
}

/** Direct children only — one more path segment. */
function childPaths(collectionPath: string): string[] {
  const prefix = `${collectionPath}/`;
  return [...store.keys()].filter(
    (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'),
  );
}

function querySnapshotOf(collectionPath: string) {
  const paths = childPaths(collectionPath);
  return {
    size: paths.length,
    empty: paths.length === 0,
    docs: paths.map((p) => ({
      id: p.split('/').pop() as string,
      exists: true,
      data: () => store.get(p),
      ref: makeDocRef(p),
    })),
  };
}

function makeDocRef(path: string): FakeDocRef {
  return {
    __kind: 'doc',
    id: path.split('/').pop() as string,
    path,
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
    get: async () => snapshotOf(path),
    set: async (payload, options) => applyWrite(path, payload, options?.merge === true),
    update: async (payload) => applyWrite(path, payload, true),
    delete: async () => {
      store.delete(path);
    },
  };
}

function makeCollectionRef(path: string): FakeCollectionRef {
  return {
    __kind: 'collection',
    path,
    doc: (id?: string) => makeDocRef(`${path}/${id ?? `auto_${++autoIdCounter}`}`),
    get: async () => querySnapshotOf(path),
  };
}

/** Ops queued on a batch, committed together as Firestore does. */
type BatchOp = () => void;

const fakeDb = {
  collection: (name: string) => makeCollectionRef(name),
  batch: () => {
    const ops: BatchOp[] = [];
    return {
      delete: (ref: FakeDocRef) => ops.push(() => store.delete(ref.path)),
      set: (ref: FakeDocRef, payload: Data, options?: { merge?: boolean }) =>
        ops.push(() => applyWrite(ref.path, payload, options?.merge === true)),
      update: (ref: FakeDocRef, payload: Data) =>
        ops.push(() => applyWrite(ref.path, payload, true)),
      commit: async () => {
        for (const op of ops) op();
      },
    };
  },
  // Reads resolve immediately, writes land on callback commit. Enough for the
  // inventory module — it reads everything before its single write, so there's
  // no read-after-write ordering to emulate.
  runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const pending: BatchOp[] = [];
    const tx = {
      get: async (ref: FakeDocRef | FakeCollectionRef) =>
        ref.__kind === 'doc' ? snapshotOf(ref.path) : querySnapshotOf(ref.path),
      set: (ref: FakeDocRef, payload: Data, options?: { merge?: boolean }) =>
        pending.push(() => applyWrite(ref.path, payload, options?.merge === true)),
      update: (ref: FakeDocRef, payload: Data) =>
        pending.push(() => applyWrite(ref.path, payload, true)),
      delete: (ref: FakeDocRef) => pending.push(() => store.delete(ref.path)),
    };
    const result = await fn(tx);
    for (const op of pending) op();
    return result;
  },
};

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => fakeDb,
  getAdminAuth: () => ({
    verifyIdToken: jest.fn().mockRejectedValue(new Error('n/a')),
  }),
  getAdminStorage: () => ({ bucket: () => ({}) }),
}));

// Imports come AFTER mocks.
import { POST } from '@/app/api/users/[uid]/mfa-reset/route';

const SUPERADMIN_UID = 'user-superadmin';
const TARGET_UID = 'user-target';
const AUDIT_ENTRIES = 'global/audit_log/entries';

function seedUser(uid: string, data: Data): void {
  store.set(`users/${uid}`, data);
}

/** Session-backed auth (no api key, so the scope check is bypassed). */
function authedAs(userId: string): void {
  mockResolveAuth.mockResolvedValue({ userId, keyContext: null });
}

/** Both factor kinds plus a live trusted device — what a real reset dismantles. */
function seedFullyEnrolledTarget(): void {
  seedUser(TARGET_UID, {
    email: 'locked-out@example.com',
    role: 'member',
    mfaEnrolled: true,
    requiresMfaSetup: false,
    mfaFactors: { totp: true, passkeys: 2 },
    mfaSecret: 'enc:v1:secret',
    backupCodes: ['hash-a', 'hash-b'],
    mfaEnrolledAt: 1_700_000_000_000,
    passkeyEnrolled: true,
  });
  store.set(`users/${TARGET_UID}/passkeys/cred-1`, { credentialId: 'cred-1' });
  store.set(`users/${TARGET_UID}/passkeys/cred-2`, { credentialId: 'cred-2' });
  store.set(`users/${TARGET_UID}/trustedDevices/hash-1`, {
    tokenHash: 'hash-1',
    expiresAt: Date.now() + 86_400_000,
  });
}

function reset(uid = TARGET_UID) {
  return POST(
    createMockRequest(`http://localhost/api/users/${uid}/mfa-reset`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ uid }) },
  );
}

/** Mutation audit events, newest last. */
function mutationEvents(): Array<Record<string, unknown>> {
  return mockEmitMutation.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  autoIdCounter = 0;
  seedUser(SUPERADMIN_UID, { role: 'superadmin', email: 'sa@example.com' });
  authedAs(SUPERADMIN_UID);
  mockSendEmail.mockResolvedValue({ error: null });
});

describe('POST /api/users/{uid}/mfa-reset', () => {
  it("tells the target's own address, and only them", async () => {
    seedFullyEnrolledTarget();

    const res = await reset();
    expect(res.status).toBe(200);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0]).toMatchObject({
      to: 'locked-out@example.com',
      subject: 'second factors removed from your owlette account',
    });
  });

  it('sends nothing when the target held no factor', async () => {
    seedUser(TARGET_UID, {
      email: 'locked-out@example.com',
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
    });

    const res = await reset();
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('leaves the target with zero factors, setup re-armed, and no trusted devices', async () => {
    seedFullyEnrolledTarget();

    const res = await reset();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      uid: TARGET_UID,
      clearedTotp: true,
      deletedPasskeys: 2,
      trustedDevicesRevoked: 1,
      enrolled: false,
      setupRequired: true,
    });

    const target = store.get(`users/${TARGET_UID}`) as Data;
    // The inventory module owns these three — the route may not write them
    // itself, so assert the outcome, not the mechanism.
    expect(target.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(target.mfaEnrolled).toBe(false);
    expect(target.requiresMfaSetup).toBe(true);

    // Nothing usable as a second factor may survive.
    expect(target.mfaSecret).toBeUndefined();
    expect(target.mfaEnrolledAt).toBeUndefined();
    expect(target.backupCodes).toEqual([]);
    expect(target.passkeyEnrolled).toBe(false);
    expect(target.mfaResetBy).toBe(SUPERADMIN_UID);
    expect(target.mfaResetAt).toBe('__SERVER_TIMESTAMP__');

    // Credentials and trust records deleted, not merely untallied.
    expect(childPaths(`users/${TARGET_UID}/passkeys`)).toEqual([]);
    expect(childPaths(`users/${TARGET_UID}/trustedDevices`)).toEqual([]);
  });

  it('refuses a non-superadmin with 403 and writes nothing', async () => {
    seedUser('user-admin', { role: 'admin', email: 'admin@example.com' });
    authedAs('user-admin');
    seedFullyEnrolledTarget();
    const before = new Map(store);

    const res = await reset();

    expect(res.status).toBe(403);

    // Every seeded doc survives byte-for-byte; the only new rows are the
    // wrapper's deny audit.
    const target = store.get(`users/${TARGET_UID}`) as Data;
    expect(target).toEqual(before.get(`users/${TARGET_UID}`));
    expect(childPaths(`users/${TARGET_UID}/passkeys`)).toHaveLength(2);
    expect(childPaths(`users/${TARGET_UID}/trustedDevices`)).toHaveLength(1);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('records an audit row naming the acting superadmin and the target', async () => {
    seedFullyEnrolledTarget();

    await reset();

    // The human-readable row: who, to whom, what was taken.
    const events = mutationEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'user_mutated',
      actor: `user:${SUPERADMIN_UID}`,
      targetId: TARGET_UID,
    });
    expect(events[0].attributes).toMatchObject({
      verb: 'mfa_force_reset',
      actorUid: SUPERADMIN_UID,
      targetUid: TARGET_UID,
      targetEmail: 'locked-out@example.com',
      clearedTotp: true,
      deletedPasskeys: 2,
      trustedDevicesRevoked: 1,
      stillEnrolled: false,
      setupReArmed: true,
    });

    // …and the wrapper's capability row, which auditors query by capability
    // rather than by verb.
    const capabilityRows = childPaths(AUDIT_ENTRIES).map(
      (p) => store.get(p) as Data,
    );
    const allow = capabilityRows.find((row) => row.outcome === 'allow');
    expect(allow).toBeDefined();
    expect(allow).toMatchObject({
      capability: 'USER_ROLE_MANAGE',
      target: { kind: 'user', id: TARGET_UID },
    });
    expect((allow!.actor as Data).userId).toBe(SUPERADMIN_UID);
  });

  it('is a safe no-op on a user who already holds no factors', async () => {
    seedUser(TARGET_UID, {
      email: 'never-enrolled@example.com',
      role: 'member',
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });

    const res = await reset();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      clearedTotp: false,
      deletedPasskeys: 0,
      trustedDevicesRevoked: 0,
      enrolled: false,
      setupRequired: true,
    });

    const target = store.get(`users/${TARGET_UID}`) as Data;
    expect(target.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(target.requiresMfaSetup).toBe(true);
    expect(target.email).toBe('never-enrolled@example.com');
  });

  it('refuses a superadmin resetting their own factors', async () => {
    // Live sessions must use `/api/mfa/disable` (proof of possession) instead.
    const res = await reset(SUPERADMIN_UID);

    expect(res.status).toBe(403);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('404s an unknown uid without emitting a mutation', async () => {
    const res = await reset('user-nobody');

    expect(res.status).toBe(404);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });

  it('refuses a soft-deleted target so the delete cascade is not undone', async () => {
    // `userDeleteCascade` deliberately leaves `requiresMfaSetup` false — the
    // inventory module would re-arm the nag on a deleted account.
    seedUser(TARGET_UID, {
      email: 'gone@example.com',
      role: 'member',
      deletedAt: 1_700_000_000_000,
      mfaFactors: { totp: false, passkeys: 0 },
      requiresMfaSetup: false,
    });

    const res = await reset();

    expect(res.status).toBe(400);
    expect((store.get(`users/${TARGET_UID}`) as Data).requiresMfaSetup).toBe(false);
    expect(mockEmitMutation).not.toHaveBeenCalled();
  });
});
