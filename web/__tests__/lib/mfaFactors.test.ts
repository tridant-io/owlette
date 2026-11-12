/** @jest-environment node */

/**
 * MFA factor inventory (`lib/mfaFactors.server.ts`) — the single writer of
 * `mfaEnrolled` and `requiresMfaSetup`.
 *
 * Two layers: the pure helpers (deriveMfaEnrolled / normalizeMfaFactors), driven
 * directly including the legacy and half-written shapes the normalizer heals;
 * and Firestore I/O (readMfaFactors / applyMfaFactorChange) against an in-memory
 * admin-SDK mock whose `runTransaction(fn)` hands the body a store-backed `tx`.
 *
 * The hot-path guard below (readMfaFactors never reads the passkeys
 * subcollection for a well-formed doc) protects the single-document read in
 * `resolveMfaStateForUser`, which runs on every page load. Do not delete it.
 */
// Mutable state backing the mocked admin SDK (reset in beforeEach).
// users/{uid} document bodies.
let users: Map<string, Record<string, unknown>>;
// users/{uid}/passkeys — credential ids only; we just need the count.
let passkeys: Map<string, string[]>;

// Plain-value spies (reset manually — these are not jest.fn()s).
const setCalls: Array<{
  id: string;
  payload: Record<string, unknown>;
  options?: { merge?: boolean };
}> = [];
let passkeyCollectionGets = 0;
let runTransactionCalls = 0;
// Firestore re-runs a contended transaction against fresh state rather than
// interleaving it; the fake models that with a queue.
let txQueue: Promise<unknown>;

interface MockReadable {
  get: () => Promise<unknown>;
}

function makePasskeyCollectionRef(uid: string) {
  return {
    get: async () => {
      passkeyCollectionGets += 1;
      const ids = passkeys.get(uid) ?? [];
      return {
        empty: ids.length === 0,
        size: ids.length,
        docs: ids.map((id) => ({ id, data: () => ({}) })),
      };
    },
  };
}

function makeUserDocRef(uid: string) {
  return {
    id: uid,
    get: async () => ({
      exists: users.has(uid),
      data: () => users.get(uid),
    }),
    collection: (name: string) => {
      if (name !== 'passkeys') throw new Error(`unexpected subcollection: ${name}`);
      return makePasskeyCollectionRef(uid);
    },
  };
}

function makeTx() {
  return {
    get: async (ref: MockReadable) => ref.get(),
    set: (
      ref: { id: string },
      payload: Record<string, unknown>,
      options?: { merge?: boolean },
    ) => {
      setCalls.push({ id: ref.id, payload, options });
      const current = users.get(ref.id) ?? {};
      users.set(ref.id, options?.merge ? { ...current, ...payload } : { ...payload });
    },
    update: (ref: { id: string }, payload: Record<string, unknown>) => {
      const current = users.get(ref.id) ?? {};
      users.set(ref.id, { ...current, ...payload });
    },
  };
}

function makeDb() {
  return {
    collection: (name: string) => {
      if (name !== 'users') throw new Error(`unexpected collection: ${name}`);
      return { doc: (uid: string) => makeUserDocRef(uid) };
    },
    runTransaction: async <T>(fn: (tx: ReturnType<typeof makeTx>) => Promise<T>) => {
      const run = txQueue.then(() => {
        runTransactionCalls += 1;
        return fn(makeTx());
      });
      // A rejected body must not poison the queue for the next transaction.
      txQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

jest.mock('@/lib/firebase-admin', () => ({
  getAdminDb: () => makeDb(),
}));

import {
  EMPTY_MFA_FACTORS,
  applyMfaFactorChange,
  deriveMfaEnrolled,
  normalizeMfaFactors,
  readMfaFactors,
} from '@/lib/mfaFactors.server';

/** `ctx.tx` takes the real admin type; the store-backed mock stands in for it. */
const asTx = (tx: ReturnType<typeof makeTx>) =>
  tx as unknown as FirebaseFirestore.Transaction;

beforeEach(() => {
  users = new Map();
  passkeys = new Map();
  setCalls.length = 0;
  passkeyCollectionGets = 0;
  runTransactionCalls = 0;
  txQueue = Promise.resolve();
});

describe('EMPTY_MFA_FACTORS', () => {
  it('is the zero inventory and is frozen', () => {
    expect(EMPTY_MFA_FACTORS).toEqual({ totp: false, passkeys: 0 });
    expect(Object.isFrozen(EMPTY_MFA_FACTORS)).toBe(true);
  });
});

describe('deriveMfaEnrolled — truth table', () => {
  it('false / 0 → false', () => {
    expect(deriveMfaEnrolled({ totp: false, passkeys: 0 })).toBe(false);
  });
  it('true / 0 → true', () => {
    expect(deriveMfaEnrolled({ totp: true, passkeys: 0 })).toBe(true);
  });
  it('false / 1 → true', () => {
    expect(deriveMfaEnrolled({ totp: false, passkeys: 1 })).toBe(true);
  });
  it('true / 2 → true', () => {
    expect(deriveMfaEnrolled({ totp: true, passkeys: 2 })).toBe(true);
  });
});

describe('normalizeMfaFactors', () => {
  it('returns a modern stored inventory verbatim, ignoring the fallback count', () => {
    const data = { mfaFactors: { totp: true, passkeys: 2 }, mfaEnrolled: false };
    expect(normalizeMfaFactors(data, 99)).toEqual({ totp: true, passkeys: 2 });
  });

  it('heals a legacy TOTP user from mfaEnrolled:true', () => {
    expect(normalizeMfaFactors({ mfaEnrolled: true }, 0)).toEqual({
      totp: true,
      passkeys: 0,
    });
  });

  it('heals a legacy passkey-only user from the real subcollection count', () => {
    expect(normalizeMfaFactors({ mfaEnrolled: false }, 3)).toEqual({
      totp: false,
      passkeys: 3,
    });
  });

  it('does not treat a stored mfaSecret as enrollment', () => {
    // An in-flight TOTP setup parks its secret in `mfa_pending/{uid}`, so a secret
    // on the user doc is not proof of a completed factor.
    expect(normalizeMfaFactors({ mfaSecret: 'ENCRYPTED' }, 0)).toEqual({
      totp: false,
      passkeys: 0,
    });
  });

  it('validates each leg independently — bad totp, good passkeys', () => {
    const data = { mfaFactors: { totp: 'yes', passkeys: 2 }, mfaEnrolled: true };
    expect(normalizeMfaFactors(data, 7)).toEqual({ totp: true, passkeys: 2 });
  });

  it('validates each leg independently — good totp, bad passkeys', () => {
    const data = { mfaFactors: { totp: false, passkeys: -1 }, mfaEnrolled: true };
    expect(normalizeMfaFactors(data, 4)).toEqual({ totp: false, passkeys: 4 });
  });

  it('rejects a non-integer passkeys leg and falls back to the real count', () => {
    const data = { mfaFactors: { totp: false, passkeys: 1.5 } };
    expect(normalizeMfaFactors(data, 2)).toEqual({ totp: false, passkeys: 2 });
  });

  it('rejects a non-object mfaFactors and falls back on both legs', () => {
    expect(normalizeMfaFactors({ mfaFactors: 'nope', mfaEnrolled: true }, 1)).toEqual({
      totp: true,
      passkeys: 1,
    });
    expect(normalizeMfaFactors({ mfaFactors: null, mfaEnrolled: false }, 0)).toEqual({
      totp: false,
      passkeys: 0,
    });
  });

  it('returns the empty inventory for an undefined document', () => {
    expect(normalizeMfaFactors(undefined, 0)).toEqual({ totp: false, passkeys: 0 });
  });

  it('clamps a nonsense fallback count', () => {
    expect(normalizeMfaFactors(undefined, -5)).toEqual({ totp: false, passkeys: 0 });
    expect(normalizeMfaFactors(undefined, Number.NaN)).toEqual({
      totp: false,
      passkeys: 0,
    });
  });
});

describe('readMfaFactors', () => {
  it('HOT PATH: a well-formed inventory never touches the passkeys subcollection', async () => {
    users.set('u1', { mfaFactors: { totp: false, passkeys: 2 } });
    // A subcollection that disagrees — the stored inventory must still win, and
    // must be returned without a second read.
    passkeys.set('u1', ['cred-a', 'cred-b', 'cred-c']);

    const inv = await readMfaFactors('u1');

    expect(inv).toEqual({ totp: false, passkeys: 2 });
    expect(passkeyCollectionGets).toBe(0);
  });

  it('falls back to the subcollection count when a leg is malformed', async () => {
    users.set('u1', { mfaFactors: { totp: true, passkeys: 'two' } });
    passkeys.set('u1', ['cred-a', 'cred-b', 'cred-c']);

    const inv = await readMfaFactors('u1');

    expect(inv).toEqual({ totp: true, passkeys: 3 });
    expect(passkeyCollectionGets).toBe(1);
  });

  it('heals a legacy TOTP-only document (no mfaFactors at all)', async () => {
    users.set('u1', { mfaEnrolled: true });

    const inv = await readMfaFactors('u1');

    expect(inv).toEqual({ totp: true, passkeys: 0 });
    expect(passkeyCollectionGets).toBe(1);
  });

  it('returns the empty inventory for a missing user doc without throwing', async () => {
    const inv = await readMfaFactors('ghost');
    expect(inv).toEqual({ totp: false, passkeys: 0 });
    expect(passkeyCollectionGets).toBe(0);
  });

  it('reads through a supplied transaction rather than the bare refs', async () => {
    users.set('u1', { mfaFactors: { totp: true, passkeys: 0 } });
    const tx = makeTx();
    const getSpy = jest.spyOn(tx, 'get');

    const inv = await readMfaFactors('u1', { tx: asTx(tx) });

    expect(inv).toEqual({ totp: true, passkeys: 0 });
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(runTransactionCalls).toBe(0);
  });

  it('recounts a legacy doc through the supplied transaction, not a bare read', async () => {
    // Inside a caller's transaction the subcollection fallback must also go through
    // `tx`: a bare `passkeysCol.get()` is a non-transactional read of state the same
    // transaction is about to write, which Firestore rejects after a write.
    users.set('u1', { mfaEnrolled: true });
    passkeys.set('u1', ['a', 'b']);
    const tx = makeTx();
    const getSpy = jest.spyOn(tx, 'get');

    const inv = await readMfaFactors('u1', { tx: asTx(tx) });

    expect(inv).toEqual({ totp: true, passkeys: 2 });
    // Both reads — the user doc AND the subcollection — went through the tx.
    expect(getSpy).toHaveBeenCalledTimes(2);
    expect(passkeyCollectionGets).toBe(1);
  });
});

describe('applyMfaFactorChange — guards', () => {
  it('throws when both passkeys and recountPasskeys are supplied', async () => {
    users.set('u1', {});
    await expect(
      applyMfaFactorChange('u1', { passkeys: 1, recountPasskeys: true }),
    ).rejects.toThrow('mfaFactors: pass either passkeys or recountPasskeys, not both');
    expect(setCalls).toHaveLength(0);
  });

  it('throws on a non-finite explicit passkeys count', async () => {
    users.set('u1', {});
    await expect(
      applyMfaFactorChange('u1', { passkeys: Number.NaN }),
    ).rejects.toThrow('mfaFactors: passkeys must be a finite number');
  });

  it('throws — and never creates the doc — when the user does not exist', async () => {
    await expect(applyMfaFactorChange('ghost', { totp: true })).rejects.toThrow(
      'mfaFactors: user ghost not found',
    );
    expect(setCalls).toHaveLength(0);
    expect(users.has('ghost')).toBe(false);
  });

  it('throws on an empty userId', async () => {
    await expect(applyMfaFactorChange('', { totp: true })).rejects.toThrow(
      'mfaFactors: userId is required',
    );
  });
});

describe('applyMfaFactorChange — counting', () => {
  it('recounts from the subcollection when recountPasskeys is set, overriding a stale copy', async () => {
    users.set('u1', { mfaFactors: { totp: false, passkeys: 1 } });
    passkeys.set('u1', ['a', 'b', 'c']);

    const result = await applyMfaFactorChange('u1', { recountPasskeys: true });

    expect(result.factors).toEqual({ totp: false, passkeys: 3 });
    expect(passkeyCollectionGets).toBe(1);
    expect(setCalls[0].payload.mfaFactors).toEqual({ totp: false, passkeys: 3 });
  });

  it('uses an explicit count without reading the subcollection', async () => {
    users.set('u1', { mfaFactors: { totp: false, passkeys: 1 } });
    passkeys.set('u1', ['a', 'b', 'c']);

    const result = await applyMfaFactorChange('u1', { passkeys: 2 });

    expect(result.factors).toEqual({ totp: false, passkeys: 2 });
    expect(passkeyCollectionGets).toBe(0);
  });

  it('carries the stored copy forward when neither leg is supplied', async () => {
    users.set('u1', { mfaFactors: { totp: true, passkeys: 2 } });
    passkeys.set('u1', ['a']);

    const result = await applyMfaFactorChange('u1', {});

    expect(result.factors).toEqual({ totp: true, passkeys: 2 });
    expect(passkeyCollectionGets).toBe(0);
  });

  // Regression: a legacy doc (no `mfaFactors` leg) describes EVERY account until
  // the backfill runs. An earlier revision resolved the count to 0 whenever
  // `recountPasskeys` was unset, writing `passkeys: 0` over real credentials.
  // Verified to FAIL against that revision (both cases reported `Received: 0`).
  it('recounts a legacy doc rather than erasing real passkeys', async () => {
    users.set('u1', { mfaEnrolled: false });
    passkeys.set('u1', ['a', 'b']);

    const result = await applyMfaFactorChange('u1', { totp: true });

    expect(result.factors).toEqual({ totp: true, passkeys: 2 });
    expect(passkeyCollectionGets).toBe(1);
  });

  it('never demotes a legacy passkey holder to zero factors', async () => {
    // Getting this wrong reports mfaEnrolled:false for an account holding two
    // working credentials — the MFA gate failing OPEN.
    users.set('u1', { mfaEnrolled: false });
    passkeys.set('u1', ['a', 'b']);

    const result = await applyMfaFactorChange('u1', { totp: false });

    expect(result.factors.passkeys).toBe(2);
    expect(result.mfaEnrolled).toBe(true);
    expect(result.requiresMfaSetup).toBe(false);
  });

  it('treats an explicit passkeys: 0 as a value, not as "not supplied"', async () => {
    // `change.passkeys !== undefined`, deliberately not truthiness: a `||` would
    // carry the stored 3 forward and leave removed credentials counted.
    users.set('u1', { mfaFactors: { totp: false, passkeys: 3 } });
    passkeys.set('u1', ['a', 'b', 'c']);

    const result = await applyMfaFactorChange('u1', { passkeys: 0 });

    expect(result).toEqual({
      factors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
    expect(passkeyCollectionGets).toBe(0);
  });

  it('clamps a negative or fractional explicit count', async () => {
    users.set('u1', {});
    expect((await applyMfaFactorChange('u1', { passkeys: -3 })).factors.passkeys).toBe(0);
    expect((await applyMfaFactorChange('u1', { passkeys: 2.7 })).factors.passkeys).toBe(2);
  });
});

describe('applyMfaFactorChange — the derived flags', () => {
  it('zero factors writes mfaEnrolled:false and requiresMfaSetup:true', async () => {
    users.set('u1', { mfaFactors: { totp: true, passkeys: 0 }, mfaEnrolled: true });

    const result = await applyMfaFactorChange('u1', { totp: false });

    expect(result).toEqual({
      factors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
    expect(setCalls[0].payload).toMatchObject({
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
    expect(users.get('u1')).toMatchObject({
      mfaEnrolled: false,
      requiresMfaSetup: true,
    });
  });

  it('a passkey-only enrollment clears requiresMfaSetup', async () => {
    // Without the false-write a passkey-only signup keeps the nag and the
    // dashboard loops it to /setup-2fa.
    users.set('u1', { requiresMfaSetup: true, mfaEnrolled: false });

    const result = await applyMfaFactorChange('u1', { passkeys: 1 });

    expect(result).toEqual({
      factors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    expect(users.get('u1')).toMatchObject({
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
  });

  it('a TOTP enrollment on a fresh account clears requiresMfaSetup', async () => {
    users.set('u1', { requiresMfaSetup: true });

    const result = await applyMfaFactorChange('u1', { totp: true });

    expect(result.mfaEnrolled).toBe(true);
    expect(result.requiresMfaSetup).toBe(false);
  });

  it('keeps mfaEnrolled true when one of two factors is removed', async () => {
    users.set('u1', { mfaFactors: { totp: true, passkeys: 1 }, mfaEnrolled: true });

    const result = await applyMfaFactorChange('u1', { totp: false });

    expect(result).toEqual({
      factors: { totp: false, passkeys: 1 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
  });
});

describe('applyMfaFactorChange — the write', () => {
  it('performs exactly one merge set, with extraUpdate in the same payload', async () => {
    users.set('u1', {
      mfaFactors: { totp: true, passkeys: 0 },
      mfaEnrolled: true,
      mfaSecret: 'ENCRYPTED',
      backupCodes: ['x'],
    });

    await applyMfaFactorChange(
      'u1',
      { totp: false },
      {
        extraUpdate: {
          mfaSecret: null,
          backupCodes: [],
          mfaDisabledAt: 1234,
        },
      },
    );

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].id).toBe('u1');
    expect(setCalls[0].options).toEqual({ merge: true });
    expect(setCalls[0].payload).toEqual({
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
      sessionsValidAfter: expect.any(Number),
      mfaSecret: null,
      backupCodes: [],
      mfaDisabledAt: 1234,
    });
  });

  it('ends every login session minted before the change, in the same write', async () => {
    users.set('u1', { mfaFactors: { totp: false, passkeys: 0 } });
    const before = Date.now();
    await applyMfaFactorChange('u1', { totp: true });
    expect(setCalls[0].payload.sessionsValidAfter).toBeGreaterThanOrEqual(before);
    expect(setCalls[0].payload.sessionsValidAfter).toBeLessThanOrEqual(Date.now());
  });

  it('opens its own transaction when no ctx.tx is supplied', async () => {
    users.set('u1', {});
    await applyMfaFactorChange('u1', { totp: true });
    expect(runTransactionCalls).toBe(1);
  });

  it('folds into a supplied ctx.tx and never opens its own transaction', async () => {
    users.set('u1', {});
    const tx = makeTx();

    const result = await applyMfaFactorChange('u1', { totp: true }, { tx: asTx(tx) });

    expect(runTransactionCalls).toBe(0);
    expect(result.mfaEnrolled).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].payload).toMatchObject({ mfaEnrolled: true });
  });

  it('folds extraUpdate into the same single write on the ctx.tx path', async () => {
    // `extraUpdate` exists so the caller's cleanup commits with the flags;
    // dropping it on the tx branch leaves a disabled account holding its secret.
    users.set('u1', { mfaFactors: { totp: true, passkeys: 0 }, mfaSecret: 'ENCRYPTED' });
    const tx = makeTx();

    await applyMfaFactorChange(
      'u1',
      { totp: false },
      { tx: asTx(tx), extraUpdate: { mfaSecret: null } },
    );

    expect(runTransactionCalls).toBe(0);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].options).toEqual({ merge: true });
    expect(setCalls[0].payload).toEqual({
      mfaFactors: { totp: false, passkeys: 0 },
      mfaEnrolled: false,
      requiresMfaSetup: true,
      sessionsValidAfter: expect.any(Number),
      mfaSecret: null,
    });
  });
});

describe('applyMfaFactorChange — concurrent callers', () => {
  it('composes two in-flight changes instead of losing a leg', async () => {
    // Two tabs finishing enrollment at once (TOTP vs passkey). What this pins on
    // the MODULE is that every read happens inside the transaction body: hoist the
    // user-doc read above `runTransaction` and the second commit writes its
    // pre-computed `totp: false` over the first enrollment — a factor silently lost.
    users.set('u1', { mfaEnrolled: false }); // legacy doc — no mfaFactors leg
    passkeys.set('u1', ['a', 'b']);

    const [totpResult, passkeyResult] = await Promise.all([
      applyMfaFactorChange('u1', { totp: true }),
      applyMfaFactorChange('u1', { passkeys: 2 }),
    ]);

    expect(runTransactionCalls).toBe(2);
    expect(setCalls).toHaveLength(2);
    // Whichever commits second reads the winner's write and carries it forward.
    expect(users.get('u1')).toMatchObject({
      mfaFactors: { totp: true, passkeys: 2 },
      mfaEnrolled: true,
      requiresMfaSetup: false,
    });
    expect(totpResult.factors.totp).toBe(true);
    expect(passkeyResult.factors).toEqual({ totp: true, passkeys: 2 });
  });
});
