/** @jest-environment node */

/**
 * `performUserDeleteCascade` — the superadmin path behind `DELETE /api/users/{uid}`
 * (self-delete lives in deleteOwnAccount.test.ts). Asserts revokeRefreshTokens +
 * updateUser({disabled:true}) each fire exactly once, with or without owned
 * sites; `auth/user-not-found` still reports authDisabled; and a throwing
 * getAdminAuth() still completes the Firestore soft-delete, which the rules gate
 * on via deletedAt.
 */

const mockRevokeRefreshTokens = jest.fn();
const mockUpdateUser = jest.fn();
const adminAuthFactory = jest.fn(() => ({
  revokeRefreshTokens: mockRevokeRefreshTokens,
  updateUser: mockUpdateUser,
}));

// Mutable doc store backing the mocked admin SDK.
interface DocSeed {
  exists: boolean;
  data?: Record<string, unknown>;
}
let docs: Map<string, DocSeed>;
let updateCalls: Array<{ path: string; payload: Record<string, unknown> }>;
let deletePaths: string[];
/** Site ids that `sites.where('owner','==',uid)` reports for the departing user. */
let ownedSiteIds: string[];

function makeDocRef(path: string): Record<string, unknown> {
  return {
    path,
    collection: (sub: string) => makeCollectionRef(`${path}/${sub}`),
    get: async () => {
      const seed = docs.get(path);
      return {
        exists: seed?.exists ?? false,
        data: () => (seed?.exists ? seed.data : undefined),
      };
    },
    update: async (payload: Record<string, unknown>) => {
      updateCalls.push({ path, payload });
      const prev = docs.get(path);
      docs.set(path, {
        exists: true,
        data: { ...(prev?.data ?? {}), ...payload },
      });
    },
    delete: async () => {
      deletePaths.push(path);
      docs.set(path, { exists: false });
    },
  };
}

/**
 * Snapshot docs for the direct children of `path`, so the subcollection-sweep
 * assertions (passkeys / trustedDevices) need no per-collection seeding.
 */
function collectionDocs(path: string): Array<Record<string, unknown>> {
  const prefix = `${path}/`;
  const out: Array<Record<string, unknown>> = [];
  for (const [docPath, seed] of docs.entries()) {
    if (!seed.exists) continue;
    if (!docPath.startsWith(prefix)) continue;
    // Direct children only — skip nested subcollection paths.
    if (docPath.slice(prefix.length).includes('/')) continue;
    const id = docPath.slice(prefix.length);
    out.push({
      id,
      data: () => seed.data,
      ref: makeDocRef(docPath),
    });
  }
  return out;
}

function makeCollectionRef(path: string): Record<string, unknown> {
  return {
    doc: (id: string) => makeDocRef(`${path}/${id}`),
    where: () => ({
      get: async () => {
        // The cascade's only `where` is sites.where('owner','==',uid). Default
        // empty; the transfer tests below set `ownedSiteIds` to drive it.
        return { docs: ownedSiteIds.map((id) => ({ id })) };
      },
    }),
    get: async () => ({ docs: collectionDocs(path) }),
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminAuth: () => adminAuthFactory(),
  getAdminDb: () => ({
    collection: (name: string) => makeCollectionRef(name),
  }),
}));

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    arrayUnion: (...vals: unknown[]) => ({ __op: 'arrayUnion', vals }),
    delete: () => '__FIELD_DELETE__',
  },
}));

const mockTransfer = jest.fn();
jest.mock('@/lib/actions/transferSiteOwnership.server', () => ({
  transferSiteOwnership: (...args: unknown[]) => mockTransfer(...args),
}));

import { performUserDeleteCascade } from '@/lib/userDeleteCascade.server';

beforeEach(() => {
  jest.clearAllMocks();
  docs = new Map();
  updateCalls = [];
  deletePaths = [];
  ownedSiteIds = [];
  mockTransfer.mockResolvedValue({ ok: true, previousOwnerUid: 'alice', newOwnerUid: 'bob' });
  mockRevokeRefreshTokens.mockResolvedValue(undefined);
  mockUpdateUser.mockResolvedValue(undefined);
  adminAuthFactory.mockReturnValue({
    revokeRefreshTokens: mockRevokeRefreshTokens,
    updateUser: mockUpdateUser,
  });
});

describe('performUserDeleteCascade — Firebase Auth revoke side-effect', () => {
  it('revokes refresh tokens AND disables the Auth user on happy path', async () => {
    docs.set('users/uid-victim', {
      exists: true,
      data: { uid: 'uid-victim', role: 'member', sites: [] },
    });

    const outcome = await performUserDeleteCascade('uid-victim');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');

    expect(mockRevokeRefreshTokens).toHaveBeenCalledTimes(1);
    expect(mockRevokeRefreshTokens).toHaveBeenCalledWith('uid-victim');

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith('uid-victim', {
      disabled: true,
    });

    expect(outcome.authDisabled).toBe(true);
    const softDelete = updateCalls.find((call) => call.path === 'users/uid-victim');
    expect(softDelete?.payload).toMatchObject({
      sites: [],
      mfaEnrolled: false,
      // Zero the denormalized inventory too: a stale `{totp:true, passkeys:n}` is
      // well-formed enough for `normalizeMfaFactors` to trust, so the next
      // recompute would resurrect `mfaEnrolled: true` on a deleted account.
      mfaFactors: { totp: false, passkeys: 0 },
      mfaSecret: '__FIELD_DELETE__',
      backupCodes: [],
      mfaEnrolledAt: '__FIELD_DELETE__',
      // Deliberately false, not re-armed — written directly rather than via
      // `applyMfaFactorChange`, which derives `requiresMfaSetup = true` on zero
      // factors and would push a soft-deleted account into mandatory 2FA setup.
      requiresMfaSetup: false,
      deletedBy: 'superadmin',
    });
    expect(softDelete?.payload.deletedAt).toEqual(expect.any(Number));
    // toMatchObject is subset-matching, so assert the zeroed inventory exactly.
    expect(softDelete?.payload.mfaFactors).toEqual({ totp: false, passkeys: 0 });
    expect(softDelete?.payload.requiresMfaSetup).toBe(false);
  });

  it('treats auth/user-not-found from updateUser as already-disabled (no rollback)', async () => {
    docs.set('users/uid-gone', {
      exists: true,
      data: { uid: 'uid-gone', role: 'member', sites: [] },
    });
    const notFound = new Error('not found') as Error & { code?: string };
    notFound.code = 'auth/user-not-found';
    mockUpdateUser.mockRejectedValueOnce(notFound);

    const outcome = await performUserDeleteCascade('uid-gone');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');
    // Still flags authDisabled: no Auth record to disable is the same end state.
    expect(outcome.authDisabled).toBe(true);
  });

  it('continues even when getAdminAuth() throws (rules already gate on deletedAt)', async () => {
    docs.set('users/uid-no-auth', {
      exists: true,
      data: { uid: 'uid-no-auth', role: 'member', sites: [] },
    });
    adminAuthFactory.mockImplementationOnce(() => {
      throw new Error('admin SDK uninitialised');
    });

    const outcome = await performUserDeleteCascade('uid-no-auth');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');
    // Soft-delete still happened — deletedAt is what firestore.rules gates on.
    expect(outcome.authDisabled).toBe(false);
    const userDoc = docs.get('users/uid-no-auth');
    expect(userDoc?.data?.deletedAt).toBeDefined();
  });

  it('non-fatal: revokeRefreshTokens failure (non-not-found) does NOT block updateUser', async () => {
    docs.set('users/uid-revoke-flake', {
      exists: true,
      data: { uid: 'uid-revoke-flake', role: 'member', sites: [] },
    });
    mockRevokeRefreshTokens.mockRejectedValueOnce(new Error('transient'));

    const outcome = await performUserDeleteCascade('uid-revoke-flake');

    expect(outcome.kind).toBe('deleted');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith('uid-revoke-flake', {
      disabled: true,
    });
  });

  it('already-soft-deleted user returns already_deleted without re-revoking', async () => {
    docs.set('users/uid-soft', {
      exists: true,
      data: {
        uid: 'uid-soft',
        role: 'member',
        sites: [],
        deletedAt: 1700000000000,
      },
    });

    const outcome = await performUserDeleteCascade('uid-soft');

    expect(outcome.kind).toBe('already_deleted');
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('sweeps the trustedDevices subcollection so stale device-trust cookies die', async () => {
    docs.set('users/uid-td', {
      exists: true,
      data: { uid: 'uid-td', role: 'member', sites: [] },
    });
    // Two hashed-token device-trust records (doc id === token hash).
    docs.set('users/uid-td/trustedDevices/hash-1', {
      exists: true,
      data: { tokenHash: 'hash-1' },
    });
    docs.set('users/uid-td/trustedDevices/hash-2', {
      exists: true,
      data: { tokenHash: 'hash-2' },
    });

    const outcome = await performUserDeleteCascade('uid-td');

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');

    // Both device-trust docs deleted, so a surviving cookie can't resolve to a
    // record and skip the MFA challenge.
    expect(deletePaths).toContain('users/uid-td/trustedDevices/hash-1');
    expect(deletePaths).toContain('users/uid-td/trustedDevices/hash-2');
    expect(docs.get('users/uid-td/trustedDevices/hash-1')?.exists).toBe(false);
    expect(docs.get('users/uid-td/trustedDevices/hash-2')?.exists).toBe(false);
  });
});

/**
 * Wave 2 task 2.4 — succession is transactional and FAILS CLOSED.
 *
 * The old loop performed two un-batched updates per site inside a try/catch that
 * warned and continued, then soft-deleted the account regardless. Every failure
 * mode ended the same way: a site owned by a soft-deleted account, reachable by
 * nobody, because both `resolveSiteAccess` and `firestore.rules` reject a deleted
 * principal. Retrying could not fix it either — the idempotency short-circuit
 * replays the recorded response, so a partial failure was permanent.
 */
describe('performUserDeleteCascade — transfer failure aborts the delete', () => {
  function seedOwnerAndSuccessor() {
    docs.set('users/alice', {
      exists: true,
      data: { uid: 'alice', role: 'admin', sites: ['site-a'] },
    });
    docs.set('users/bob', {
      exists: true,
      data: { uid: 'bob', role: 'admin', sites: [] },
    });
    ownedSiteIds = ['site-a'];
  }

  it('leaves NO partial state when a transfer fails', async () => {
    seedOwnerAndSuccessor();
    mockTransfer.mockResolvedValue({
      ok: false,
      failure: { kind: 'successor_inactive' },
    });

    const outcome = await performUserDeleteCascade('alice', { successorUid: 'bob' });

    expect(outcome.kind).toBe('transfer_failed');
    if (outcome.kind !== 'transfer_failed') throw new Error('expected transfer_failed');
    expect(outcome.siteId).toBe('site-a');
    expect(outcome.reason).toBe('successor_inactive');

    // NOTHING destructive ran. These four assertions are the actual acceptance
    // criterion: the account must be exactly as it was.
    expect(mockRevokeRefreshTokens).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(updateCalls.some((c) => 'deletedAt' in c.payload)).toBe(false);
    expect(updateCalls.some((c) => c.path === 'users/alice')).toBe(false);
  });

  it('completes the delete when the transfer succeeds', async () => {
    // NEGATIVE CONTROL. Without it, a cascade that aborted unconditionally would
    // pass the test above just as well.
    seedOwnerAndSuccessor();
    mockTransfer.mockResolvedValue({
      ok: true,
      previousOwnerUid: 'alice',
      newOwnerUid: 'bob',
    });

    const outcome = await performUserDeleteCascade('alice', { successorUid: 'bob' });

    expect(outcome.kind).toBe('deleted');
    if (outcome.kind !== 'deleted') throw new Error('expected deleted');
    expect(outcome.transferredSites).toEqual(['site-a']);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it('reports the sites that DID move before the failure', async () => {
    docs.set('users/alice', {
      exists: true,
      data: { uid: 'alice', role: 'admin', sites: ['site-a', 'site-b'] },
    });
    docs.set('users/bob', { exists: true, data: { uid: 'bob', role: 'admin', sites: [] } });
    ownedSiteIds = ['site-a', 'site-b'];

    mockTransfer
      .mockResolvedValueOnce({ ok: true, previousOwnerUid: 'alice', newOwnerUid: 'bob' })
      .mockResolvedValueOnce({ ok: false, failure: { kind: 'site_not_found' } });

    const outcome = await performUserDeleteCascade('alice', { successorUid: 'bob' });

    expect(outcome.kind).toBe('transfer_failed');
    if (outcome.kind !== 'transfer_failed') throw new Error('expected transfer_failed');
    // site-a moved and is NOT rolled back — it moved atomically, and a re-issued
    // delete re-queries owned sites, so it simply will not appear again.
    expect(outcome.transferredSites).toEqual(['site-a']);
    expect(outcome.siteId).toBe('site-b');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('routes every transfer through the ONE transactional transfer', async () => {
    seedOwnerAndSuccessor();
    await performUserDeleteCascade('alice', { successorUid: 'bob' });

    expect(mockTransfer).toHaveBeenCalledTimes(1);
    expect(mockTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-a', successorUid: 'bob' }),
    );
  });

  it("hands sites over past the successor's plan, so a deletion is never blocked by it", async () => {
    seedOwnerAndSuccessor();
    await performUserDeleteCascade('alice', { successorUid: 'bob' });

    expect(mockTransfer).toHaveBeenCalledWith(expect.objectContaining({ skipPlanCheck: true }));
  });
});
